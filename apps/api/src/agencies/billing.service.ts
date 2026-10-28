// Agency billing — UX Gap Analysis §10 stages 4, 5, 8, 9 and 10.
// Invoices are paid only by a signed Paystack webhook or by finance marking a
// bank transfer as received. Billing state never touches live dispatch.
import { requirePerm } from '../core/auth';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  addMonth,
  agencyCopy,
  agencyFeatures,
  agencyInvoiceMachine,
  applyEvent,
  approve,
  classifyPlanChange,
  formatNaira,
  monthlyLines,
  naira,
  onboardingQuote,
  openInvoiceStates,
  prorate,
  totals,
  type AgencyInvoiceEvent,
  type AgencyInvoiceState,
  type AgencyPrice,
  type InvoiceLine,
} from '@erp/domain';
import { PAYMENTS, newReference, type PayMethod, type PaymentsAdapter } from '../adapters/payments';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { PayoutsService } from './payouts.service';
import { AgencyLifecycle, type AgencyRow } from './agency.lifecycle';

// Placeholders until pricing is settled — held as config, not code (PRD).
export const AGENCY_BILLING = {
  basePlan: 'agency_base',
  vatRate: 0.075,
  /** Onboarding invoice due in [n] days. */
  onboardingDueDays: 7,
  /** Monthly invoice due [n] days after the period starts. */
  invoiceDueDays: 14,
  /** Reminders −3 d and 0 d. */
  reminderDaysBefore: [3, 0],
  minVerifiedOfficersPerStation: 1,
  /** Payouts and waivers above this need a second approver. */
  secondApprovalAboveKobo: naira(100_000),
};

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => isoDay(new Date());
const plusDays = (day: string, n: number) => isoDay(new Date(Date.parse(day) + n * 86_400_000));

export interface InvoiceRow {
  id: string;
  agency_id: string;
  number: string;
  kind: 'onboarding' | 'monthly' | 'proration';
  lines: InvoiceLine[];
  subtotal_kobo: number;
  vat_kobo: number;
  total_kobo: number;
  po_number: string | null;
  state: AgencyInvoiceState;
  due_on: string;
  period_start: string | null;
  period_end: string | null;
  pay_by_invoice: boolean;
  transfer_account: unknown;
  reminders_sent: string[];
  waive_reason: string | null;
  waive_approvals: string[];
  paid_at: Date | null;
  created_at: Date;
}

@Injectable()
export class AgencyBillingService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(AgencyLifecycle) private readonly life: AgencyLifecycle,
    @Inject(PayoutsService) private readonly payouts: PayoutsService,
  ) {}

  // ---------------------------------------------------------------- prices and plans

  /** Fee schedule for one agency: plans, add-ons and fees, with any per-agency override applied. */
  async prices(c: Queryable, agencyId: string): Promise<Record<string, AgencyPrice>> {
    const r = await c.query(
      `select x.code, x.label, coalesce(o.amount_kobo, x.amount_kobo)::bigint as amount_kobo, x.includes, x.audience
         from (select code, name as label, price_kobo as amount_kobo, includes, audience from plans where audience in ('agency', 'agency_addon') and active
               union all select code, label, amount_kobo, '{}'::jsonb, 'fee' from agency_fees) x
         left join agency_price_overrides o on o.agency_id = $1 and o.code = x.code`,
      [agencyId],
    );
    return Object.fromEntries(r.rows.map((p) => [p.code, { code: p.code, label: p.label, amountKobo: p.amount_kobo, includes: p.includes, audience: p.audience }]));
  }

  async planCards(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId);
    const prices = await this.prices(this.db.pool, agencyId);
    const rows = Object.values(prices) as Array<AgencyPrice & { audience?: string }>;
    return {
      base: rows.filter((p) => p.audience === 'agency').map(card),
      addons: rows.filter((p) => p.audience === 'agency_addon').map(card),
      onboardingFee: card(prices.onboarding!),
      vatRate: AGENCY_BILLING.vatRate,
    };
  }

  /** Add-ons in force on a day: code → quantity (the base plan is always one). */
  async selection(c: Queryable, agencyId: string, on: string): Promise<{ base: string | null; addons: Record<string, number> }> {
    const r = await c.query(
      `select i.code, i.quantity, p.audience from agency_plan_items i join plans p on p.code = i.code
        where i.agency_id = $1 and i.starts_on <= $2 and (i.ends_on is null or i.ends_on > $2)`,
      [agencyId, on],
    );
    const base = r.rows.find((x) => x.audience === 'agency')?.code ?? null;
    return { base, addons: Object.fromEntries(r.rows.filter((x) => x.audience === 'agency_addon').map((x) => [x.code, x.quantity])) };
  }

  private validateAddons(prices: Record<string, AgencyPrice & { audience?: string }>, addons: Record<string, number>) {
    for (const code of Object.keys(addons)) {
      if (prices[code]?.audience !== 'agency_addon') throw new AppError(422, 'validation_failed', 'Choose an add-on from the list.', { fields: [{ field: `addons.${code}`, message: 'Unknown add-on.' }] });
    }
  }

  /** Stage 4: base + add-ons → onboarding invoice (fee + first period, VAT). Choosing again before paying replaces it. */
  async choosePlan(p: Principal, agencyId: string, addons: Record<string, number>) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      const prices = await this.prices(c, agencyId);
      this.validateAddons(prices, addons);
      const chosen = Object.fromEntries(Object.entries(addons).filter(([, q]) => q > 0));
      const existing = (await c.query(`select * from invoices where agency_id = $1 and kind = 'onboarding' for update`, [agencyId])).rows[0] as InvoiceRow | undefined;
      if (existing && (await this.paidSoFar(c, existing.id)) > 0) throw new AppError(409, 'payment_started', 'A payment for this plan has started. Contact support to change it.');
      const { agency } = await this.life.transition(c, agencyId, 'choose_plan', 'agency_admin', p.userId, { payload: { addons: chosen } });

      const day = today();
      // Before the fee is paid the selection is only a quote, so it is replaced outright.
      await c.query(`delete from agency_plan_items where agency_id = $1`, [agencyId]);
      for (const [code, quantity] of [[AGENCY_BILLING.basePlan, 1] as const, ...Object.entries(chosen)]) {
        await c.query(`insert into agency_plan_items (agency_id, code, quantity, starts_on, created_by) values ($1, $2, $3, $4, $5)`, [agencyId, code, quantity, day, p.userId]);
      }
      const q = onboardingQuote({ prices, basePlan: AGENCY_BILLING.basePlan, addons: chosen, vatRate: AGENCY_BILLING.vatRate });
      const dueOn = plusDays(day, AGENCY_BILLING.onboardingDueDays);
      let invoice: InvoiceRow;
      if (existing) {
        invoice = (
          await c.query(`update invoices set lines = $2, subtotal_kobo = $3, vat_kobo = $4, total_kobo = $5, due_on = $6 where id = $1 returning *`, [
            existing.id,
            JSON.stringify(q.lines),
            q.subtotalKobo,
            q.vatKobo,
            q.totalKobo,
            dueOn,
          ])
        ).rows[0];
      } else {
        invoice = await this.insertInvoice(c, agency, { kind: 'onboarding', lines: q.lines, dueOn });
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.plan_chosen', entity: 'invoice', entityId: invoice.id, payload: { addons: chosen, totalKobo: q.totalKobo } }, c);
      return {
        state: agency.status,
        invoice: this.presentInvoice(invoice, 0),
        summary: { subtotal: formatNaira(q.subtotalKobo), vat: formatNaira(q.vatKobo), total: formatNaira(q.totalKobo), monthly: formatNaira(q.monthlyKobo), monthlyKobo: q.monthlyKobo },
      };
    });
  }

  // ---------------------------------------------------------------- invoices

  private async insertInvoice(
    c: Queryable,
    agency: Pick<AgencyRow, 'id'>,
    i: { kind: InvoiceRow['kind']; lines: InvoiceLine[]; dueOn: string; periodStart?: string; periodEnd?: string },
  ): Promise<InvoiceRow> {
    const t = totals(i.lines, AGENCY_BILLING.vatRate);
    const seq = (await c.query(`select nextval('invoice_number_seq') as n`)).rows[0].n;
    const number = `INV-${i.dueOn.slice(0, 4)}-${String(seq).padStart(6, '0')}`;
    const r = await c.query(
      `insert into invoices (agency_id, number, kind, lines, subtotal_kobo, vat_kobo, total_kobo, due_on, period_start, period_end, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft') returning id`,
      [agency.id, number, i.kind, JSON.stringify(t.lines), t.subtotalKobo, t.vatKobo, t.totalKobo, i.dueOn, i.periodStart ?? null, i.periodEnd ?? null],
    );
    return this.invoiceTransition(c, r.rows[0].id, 'issue', 'system', null);
  }

  private async invoiceTransition(c: Queryable, invoiceId: string, event: AgencyInvoiceEvent, actor: 'platform_admin' | 'system', actorId: string | null, extra: Record<string, unknown> = {}) {
    const inv = (await c.query(`select * from invoices where id = $1 for update`, [invoiceId])).rows[0] as InvoiceRow | undefined;
    if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
    const r = applyEvent(agencyInvoiceMachine, inv.state, event, actor);
    if (!r.ok) throw new AppError(r.code === 'actor_not_allowed' ? 403 : 409, r.code, inv.state === 'paid' ? 'This invoice is already paid.' : `This invoice is ${inv.state}.`);
    const set: Record<string, unknown> = { ...extra, state: r.to };
    const cols = Object.keys(set);
    const out = await c.query(`update invoices set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [invoiceId, ...cols.map((k) => set[k])]);
    await this.audit.write({ actorId, actorRole: actor, action: `invoice.${event}`, entity: 'invoice', entityId: invoiceId, payload: { from: inv.state, to: r.to, totalKobo: inv.total_kobo } }, c);
    return out.rows[0] as InvoiceRow;
  }

  private async paidSoFar(c: Queryable, invoiceId: string): Promise<number> {
    return (await c.query(`select coalesce(sum(amount_kobo), 0)::bigint as s from invoice_payments where invoice_id = $1`, [invoiceId])).rows[0].s;
  }

  presentInvoice(i: InvoiceRow, paidKobo: number) {
    const balance = Math.max(0, i.total_kobo - paidKobo);
    return {
      id: i.id,
      number: i.number,
      kind: i.kind,
      state: i.state,
      dueOn: i.due_on,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      poNumber: i.po_number,
      lines: i.lines.map((l) => ({ ...l, amount: formatNaira(l.amountKobo) })),
      subtotalKobo: i.subtotal_kobo,
      vatKobo: i.vat_kobo,
      totalKobo: i.total_kobo,
      paidKobo,
      balanceKobo: balance,
      total: formatNaira(i.total_kobo),
      balance: formatNaira(balance),
      payByInvoice: i.pay_by_invoice,
      transferAccount: i.transfer_account,
      paidAt: i.paid_at,
    };
  }

  async listInvoices(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId);
    const r = await this.db.query(`select * from invoices where agency_id = $1 order by created_at desc`, [agencyId]);
    return Promise.all(r.rows.map(async (i: InvoiceRow) => this.presentInvoice(i, await this.paidSoFar(this.db.pool, i.id))));
  }

  async invoice(p: Principal, agencyId: string, invoiceId: string) {
    await this.life.requireStaff(p, agencyId);
    const i = (await this.db.query(`select * from invoices where id = $1 and agency_id = $2`, [invoiceId, agencyId])).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'Invoice not found.');
    const agency = (await this.db.query(`select legal_name, name, tin from agencies where id = $1`, [agencyId])).rows[0];
    const payments = (await this.db.query(`select amount_kobo, method, bank_reference, received_on, created_at from invoice_payments where invoice_id = $1 order by created_at`, [invoiceId])).rows;
    return { ...this.presentInvoice(i, await this.paidSoFar(this.db.pool, i.id)), billTo: { name: agency.legal_name ?? agency.name, tin: agency.tin }, payments };
  }

  private async openInvoice(c: Queryable, agencyId: string, invoiceId: string): Promise<InvoiceRow> {
    const i = (await c.query(`select * from invoices where id = $1 and agency_id = $2 for update`, [invoiceId, agencyId])).rows[0] as InvoiceRow | undefined;
    if (!i) throw new AppError(404, 'not_found', 'Invoice not found.');
    if (!openInvoiceStates.includes(i.state)) throw new AppError(409, 'invoice_closed', i.state === 'paid' ? 'This invoice is already paid.' : `This invoice is ${i.state}.`);
    return i;
  }

  // ---------------------------------------------------------------- stage 5: paying

  /** Paystack card / transfer / USSD. Paid only on the signed webhook. */
  async payWithPaystack(p: Principal, agencyId: string, invoiceId: string, method: PayMethod, idempotencyKey: string) {
    await this.life.requireStaff(p, agencyId);
    const prior = (await this.db.query(`select agency_id, provider_ref, state from payments where idempotency_key = $1`, [idempotencyKey])).rows[0];
    if (prior) {
      if (prior.agency_id !== agencyId) throw new AppError(409, 'idempotency_conflict', 'Try again.');
      return { reference: prior.provider_ref, state: prior.state, replayed: true };
    }
    const { inv, balance, email } = await this.db.tx(async (c) => {
      const inv = await this.openInvoice(c, agencyId, invoiceId);
      const balance = inv.total_kobo - (await this.paidSoFar(c, inv.id));
      const email = (await c.query(`select official_email from agencies where id = $1`, [agencyId])).rows[0].official_email;
      return { inv, balance, email };
    });
    const reference = newReference('agi');
    await this.db.tx(async (c) => {
      await c.query(
        `insert into payments (user_id, agency_id, purpose, purpose_ref, amount_kobo, method, provider_ref, idempotency_key, state)
         values ($1, $2, 'agency_invoice', $3, $4, $5, $6, $7, 'pending')`,
        [p.userId, agencyId, inv.id, balance, method, reference, idempotencyKey],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'invoice.payment_started', entity: 'invoice', entityId: inv.id, payload: { reference, method, amountKobo: balance } }, c);
    });
    const init = await this.payments.initialize({ reference, amountKobo: balance, method, email: email ?? 'billing@agency.erp.local', metadata: { purpose: 'agency_invoice', invoiceId: inv.id, agencyId } });
    return { ...init, state: 'pending' as const, amount: formatNaira(balance), message: 'Confirming your payment.' };
  }

  /** "Pay by invoice": proforma with PO number, paid into a dedicated account → Waiting for payment. */
  async payByInvoice(p: Principal, agencyId: string, invoiceId: string, poNumber: string) {
    await this.life.requireStaff(p, agencyId);
    return this.db.tx(async (c) => {
      const inv = await this.openInvoice(c, agencyId, invoiceId);
      const agency = (await c.query(`select legal_name, name, tin, official_email from agencies where id = $1`, [agencyId])).rows[0];
      let account = inv.transfer_account;
      if (!account) {
        // Paystack dedicated account: a matched transfer arrives as a normal signed webhook.
        const reference = newReference('agt');
        const balance = inv.total_kobo - (await this.paidSoFar(c, inv.id));
        await c.query(
          `insert into payments (user_id, agency_id, purpose, purpose_ref, amount_kobo, method, provider_ref, idempotency_key, state)
           values ($1, $2, 'agency_invoice', $3, $4, 'bank_transfer', $5, $6, 'pending')`,
          [p.userId, agencyId, inv.id, balance, reference, `dva:${inv.id}`],
        );
        const init = await this.payments.initialize({ reference, amountKobo: balance, method: 'bank_transfer', email: agency.official_email ?? 'billing@agency.erp.local', metadata: { purpose: 'agency_invoice', invoiceId: inv.id, agencyId } });
        // The mock gives an account number; Paystack gives a payment link the finance team can use.
        account = init.transferAccount ? { ...init.transferAccount, reference } : { payUrl: init.checkoutUrl, reference };
      }
      const updated = (await c.query(`update invoices set po_number = $2, pay_by_invoice = true, transfer_account = $3 where id = $1 returning *`, [inv.id, poNumber, JSON.stringify(account)])).rows[0];
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'invoice.pay_by_invoice', entity: 'invoice', entityId: inv.id, payload: { poNumber } }, c);
      return {
        status: 'waiting_for_payment' as const,
        message: agencyCopy.waitingForPayment,
        proforma: { ...this.presentInvoice(updated, await this.paidSoFar(c, inv.id)), billTo: { name: agency.legal_name ?? agency.name, tin: agency.tin }, title: 'Proforma invoice' },
      };
    });
  }

  /** Called by the Paystack webhook inside its transaction. */
  async onPaystackSuccess(c: Queryable, pay: { id: string; agency_id: string; purpose_ref: string; provider_ref: string }, amountKobo: number) {
    await this.applyPayment(c, pay.purpose_ref, amountKobo, { method: 'paystack', paymentId: pay.id }, null);
  }

  async onPaystackFailed(c: Queryable, pay: { agency_id: string; amount_kobo: number }) {
    const agency = (await c.query(`select id, contact_user_id from agencies where id = $1`, [pay.agency_id])).rows[0];
    if (agency) await this.life.notify(c, agency, { type: 'agency_payment_failed', grp: 'money', title: 'Payment failed', body: agencyCopy.paymentFailed(pay.amount_kobo), link: `/agency/${agency.id}/billing` });
  }

  /** Finance marks an unmatched bank transfer as received (stage 5 admin). */
  async markTransferReceived(p: Principal, invoiceId: string, b: { amountKobo: number; bankReference: string; receivedOn?: string; note?: string }) {
    requirePerm(p, 'platform.money');
    return this.db.tx(async (c) => {
      const dupe = await c.query(`select 1 from invoice_payments where bank_reference = $1`, [b.bankReference]);
      if (dupe.rowCount) throw new AppError(409, 'already_recorded', 'This bank reference is already recorded.');
      const inv = (await c.query(`select agency_id from invoices where id = $1`, [invoiceId])).rows[0];
      if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
      await this.openInvoice(c, inv.agency_id, invoiceId);
      return this.applyPayment(c, invoiceId, b.amountKobo, { method: 'bank_transfer_marked', bankReference: b.bankReference, receivedOn: b.receivedOn, note: b.note }, p.userId);
    });
  }

  /** Records money against an invoice; when covered, pays it and moves the agency on. */
  private async applyPayment(
    c: Queryable,
    invoiceId: string,
    amountKobo: number,
    via: { method: 'paystack'; paymentId: string } | { method: 'bank_transfer_marked'; bankReference: string; receivedOn?: string; note?: string },
    actorId: string | null,
  ) {
    const inv = (await c.query(`select * from invoices where id = $1 for update`, [invoiceId])).rows[0] as InvoiceRow;
    await c.query(
      `insert into invoice_payments (invoice_id, amount_kobo, method, payment_id, bank_reference, received_on, marked_by, note)
       values ($1, $2, $3, $4, $5, coalesce($6::date, current_date), $7, $8)`,
      [
        invoiceId,
        amountKobo,
        via.method,
        via.method === 'paystack' ? via.paymentId : null,
        via.method === 'bank_transfer_marked' ? via.bankReference : null,
        via.method === 'bank_transfer_marked' ? (via.receivedOn ?? null) : null,
        actorId,
        via.method === 'bank_transfer_marked' ? (via.note ?? null) : null,
      ],
    );
    await this.audit.write(
      { actorId, actorRole: actorId ? 'platform_admin' : 'system', action: 'invoice.payment_recorded', entity: 'invoice', entityId: invoiceId, payload: { amountKobo, method: via.method } },
      c,
    );
    const paid = await this.paidSoFar(c, invoiceId);
    const agency = await this.life.lock(c, inv.agency_id);
    if (!openInvoiceStates.includes(inv.state) || paid < inv.total_kobo) {
      // Part payment (or money after a waiver): recorded and shown; finance follows up.
      return { state: inv.state, paidKobo: paid, balanceKobo: Math.max(0, inv.total_kobo - paid) };
    }
    const done = await this.invoiceTransition(c, invoiceId, via.method === 'paystack' ? 'payment_confirmed' : 'transfer_marked', actorId ? 'platform_admin' : 'system', actorId, { paid_at: new Date() });
    await this.life.notify(c, agency, { type: 'agency_payment_received', grp: 'money', title: 'Payment received', body: `We received ${formatNaira(paid)} for invoice ${inv.number}.`, link: `/agency/${agency.id}/billing` });
    await this.afterInvoiceClosed(c, agency, done);
    return { state: done.state, paidKobo: paid, balanceKobo: 0 };
  }

  /** Paying the onboarding invoice starts setup; clearing the last overdue invoice restores the agency the same day. */
  private async afterInvoiceClosed(c: Queryable, agency: AgencyRow, inv: InvoiceRow) {
    if (inv.kind === 'onboarding' && agency.status === 'fee_pending') {
      const start = today();
      await this.life.transition(c, agency.id, 'fee_paid', 'system', null, { set: { period_start: start, period_end: isoDay(addMonth(new Date(start))) }, payload: { invoiceId: inv.id } });
      return;
    }
    if (agency.status === 'overdue') {
      const still = await c.query(`select 1 from invoices where agency_id = $1 and state = 'overdue'`, [agency.id]);
      if (!still.rowCount) {
        await this.life.transition(c, agency.id, 'payment_received', 'system', null, { payload: { invoiceId: inv.id } });
        await this.life.notify(c, agency, { type: 'agency_restored', grp: 'money', title: 'Payment received', body: 'You can add stations and equipment again.' });
      }
    }
  }

  // ---------------------------------------------------------------- stage 8: monthly cycle

  /**
   * Issues next period's invoice for every billable agency whose period has ended by `asOf`.
   * Lines: plan and add-ons for the new period, stations and inventory as they stand,
   * messaging used in the period that ended. Safe to rerun (one invoice per period).
   */
  async generateMonthly(p: Principal | null, asOf: string) {
    if (p) requirePerm(p, 'platform.money');
    const due = await this.db.query(`select id from agencies where status in ('setting_up', 'live', 'overdue', 'offboarding') and period_end <= $1 order by created_at`, [asOf]);
    const issued: Array<{ agencyId: string; invoiceId: string; number: string; totalKobo: number }> = [];
    for (const { id } of due.rows) {
      await this.db.tx(async (c) => {
        let agency = await this.life.lock(c, id);
        while (agency.period_end && agency.period_end <= asOf) {
          const start = agency.period_end;
          const end = isoDay(addMonth(new Date(start)));
          const exists = await c.query(`select 1 from invoices where agency_id = $1 and kind = 'monthly' and period_start = $2`, [id, start]);
          if (!exists.rowCount) {
            const lines = await this.monthlyLinesFor(c, agency, start);
            const inv = await this.insertInvoice(c, agency, { kind: 'monthly', lines, dueOn: plusDays(start, AGENCY_BILLING.invoiceDueDays), periodStart: start, periodEnd: end });
            issued.push({ agencyId: id, invoiceId: inv.id, number: inv.number, totalKobo: inv.total_kobo });
            await this.life.notify(c, agency, { type: 'agency_invoice_issued', grp: 'money', title: 'Invoice issued', body: `Invoice ${inv.number} for ${formatNaira(inv.total_kobo)} is due on ${inv.due_on}.`, link: `/agency/${id}/billing/${inv.id}` });
          }
          agency = (await c.query(`update agencies set period_start = $2, period_end = $3 where id = $1 returning *`, [id, start, end])).rows[0];
        }
      });
    }
    return { asOf, issued };
  }

  private async monthlyLinesFor(c: Queryable, agency: AgencyRow, periodStart: string): Promise<InvoiceLine[]> {
    const prices = await this.prices(c, agency.id);
    const sel = await this.selection(c, agency.id, periodStart);
    const stations = (await c.query(`select count(*)::int as n from stations where agency_id = $1 and status <> 'paused'`, [agency.id])).rows[0].n;
    const inventory = Object.fromEntries(
      (await c.query(`select fee_code, sum(quantity)::int as q from agency_inventory where agency_id = $1 and removed_at is null group by fee_code`, [agency.id])).rows.map((r) => [r.fee_code, r.q]),
    );
    const usage = Object.fromEntries(
      (
        await c.query(`select fee_code, sum(units)::int as u from agency_usage where agency_id = $1 and at >= $2::date and at < $3::date group by fee_code order by fee_code`, [
          agency.id,
          agency.period_start,
          periodStart,
        ])
      ).rows.map((r) => [r.fee_code, r.u]),
    );
    return monthlyLines({ prices, basePlan: sel.base ?? AGENCY_BILLING.basePlan, addons: sel.addons, stationCount: stations, inventory, usage, vatRate: AGENCY_BILLING.vatRate });
  }

  // ---------------------------------------------------------------- stage 9: reminders and overdue

  /** Sends −3 d / 0 d reminders and marks unpaid invoices overdue the day after they're due. Never touches dispatch. */
  async sweepOverdue(p: Principal | null, asOf: string) {
    if (p) requirePerm(p, 'platform.money');
    const reminded: string[] = [];
    const overdue: string[] = [];
    await this.db.tx(async (c) => {
      for (const n of AGENCY_BILLING.reminderDaysBefore) {
        const tag = `d-${n}`;
        const r = await c.query(
          `update invoices set reminders_sent = array_append(reminders_sent, $2) where state = 'issued' and due_on = $1::date + $3::int and not ($2 = any(reminders_sent)) returning *`,
          [asOf, tag, n],
        );
        for (const inv of r.rows as InvoiceRow[]) {
          reminded.push(inv.id);
          const agency = (await c.query(`select id, contact_user_id from agencies where id = $1`, [inv.agency_id])).rows[0];
          await this.life.notify(c, agency, {
            type: 'agency_invoice_due',
            grp: 'money',
            title: n === 0 ? 'Invoice due today' : 'Invoice due soon',
            body: `Invoice ${inv.number} for ${formatNaira(inv.total_kobo)} is due on ${inv.due_on}.`,
            link: `/agency/${inv.agency_id}/billing/${inv.id}`,
          });
        }
      }
      const late = await c.query(`select id, agency_id from invoices where state = 'issued' and due_on < $1 order by due_on`, [asOf]);
      for (const inv of late.rows) {
        const done = await this.invoiceTransition(c, inv.id, 'mark_overdue', 'system', null);
        overdue.push(inv.id);
        const agency = await this.life.lock(c, inv.agency_id);
        if (agency.status === 'live') await this.life.transition(c, agency.id, 'invoice_overdue', 'system', null, { payload: { invoiceId: inv.id } });
        await this.life.notify(c, agency, { type: 'agency_invoice_overdue', grp: 'money', title: 'Invoice overdue', body: `${agencyCopy.overdueBanner} Invoice ${done.number}: ${formatNaira(done.total_kobo)}.`, link: `/agency/${agency.id}/billing/${inv.id}` });
      }
    });
    return { asOf, reminded, overdue };
  }

  /** Admin dunning list: open invoices across agencies, overdue first. */
  async dunning(p: Principal, state?: AgencyInvoiceState) {
    requirePerm(p, 'platform.money');
    const r = await this.db.query(
      `select i.*, a.name as agency_name from invoices i join agencies a on a.id = i.agency_id
        where ($1::text is null and i.state in ('issued', 'overdue')) or i.state = $1
        order by (i.state = 'overdue') desc, i.due_on`,
      [state ?? null],
    );
    return Promise.all(r.rows.map(async (i) => ({ agency: { id: i.agency_id, name: i.agency_name }, ...this.presentInvoice(i, await this.paidSoFar(this.db.pool, i.id)) })));
  }

  /** Billing hold for adding stations and inventory. Dispatch is never checked here. */
  async assertNotOnHold(c: Queryable, agencyId: string, what: 'addStations' | 'addInventory') {
    const a = (await c.query(`select status from agencies where id = $1`, [agencyId])).rows[0];
    if (a?.status === 'overdue') {
      const due = (await c.query(`select min(due_on) as d from invoices where agency_id = $1 and state = 'overdue'`, [agencyId])).rows[0].d;
      throw new AppError(402, 'billing_hold', agencyCopy.overdueBanner, { line: due ? agencyCopy.overdueLine(due) : undefined, action: `/agency/${agencyId}/billing` });
    }
    if (!a || !agencyFeatures[a.status as keyof typeof agencyFeatures][what]) {
      throw new AppError(409, 'not_available', what === 'addStations' ? 'You can add stations once your onboarding fee is paid.' : 'You can add equipment once your onboarding fee is paid.');
    }
  }

  // ---------------------------------------------------------------- stage 10: change plan

  /** Upgrades apply now (prorated invoice); downgrades at period end. `confirm: false` previews the new monthly amount. */
  async changePlan(p: Principal, agencyId: string, addons: Record<string, number>, confirm: boolean) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      const agency = await this.life.lock(c, agencyId);
      if (!agencyFeatures[agency.status].changePlan) throw new AppError(409, 'not_available', 'You can change your plan once setup has started.');
      const prices = await this.prices(c, agencyId);
      this.validateAddons(prices, addons);
      const day = today();
      const current = await this.selection(c, agencyId, day);
      const changes = classifyPlanChange(current.addons, addons);
      if (agency.status === 'overdue' && changes.some((x) => x.when === 'now')) throw new AppError(402, 'billing_hold', agencyCopy.overdueBanner, { action: `/agency/${agencyId}/billing` });

      const base = current.base ?? AGENCY_BILLING.basePlan;
      const monthly = (a: Record<string, number>) => totals(monthlyLines({ prices, basePlan: base, addons: a, vatRate: AGENCY_BILLING.vatRate }), AGENCY_BILLING.vatRate).totalKobo;
      const afterNow = { ...current.addons, ...Object.fromEntries(changes.filter((x) => x.when === 'now').map((x) => [x.code, x.to])) };
      const proration: InvoiceLine[] = changes
        .filter((x) => x.when === 'now')
        .map((x) => {
          const unit = prorate(prices[x.code]!.amountKobo, new Date(agency.period_start!), new Date(agency.period_end!), new Date(day));
          return { code: x.code, label: `${prices[x.code]!.label} (prorated to ${agency.period_end})`, quantity: x.to - x.from, unitKobo: unit, amountKobo: unit * (x.to - x.from) };
        })
        .filter((l) => l.amountKobo > 0);
      const preview = {
        changes,
        currentMonthly: formatNaira(monthly(current.addons)),
        newMonthlyKobo: monthly(addons),
        newMonthly: formatNaira(monthly(addons)),
        fromNextPeriodOn: agency.period_end,
        dueNow: formatNaira(totals(proration, AGENCY_BILLING.vatRate).totalKobo),
      };
      if (!confirm || !changes.length) return { ...preview, applied: false };

      for (const ch of changes) {
        const at = ch.when === 'now' ? day : agency.period_end!;
        // Drop any change scheduled earlier for this add-on, then close the running row at `at`.
        await c.query(`delete from agency_plan_items where agency_id = $1 and code = $2 and starts_on > $3`, [agencyId, ch.code, day]);
        await c.query(`delete from agency_plan_items where agency_id = $1 and code = $2 and starts_on >= $3`, [agencyId, ch.code, at]);
        await c.query(`update agency_plan_items set ends_on = $3 where agency_id = $1 and code = $2 and starts_on < $3 and (ends_on is null or ends_on > $3)`, [agencyId, ch.code, at]);
        if (ch.to > 0) await c.query(`insert into agency_plan_items (agency_id, code, quantity, starts_on, created_by) values ($1, $2, $3, $4, $5)`, [agencyId, ch.code, ch.to, at, p.userId]);
      }
      let invoice;
      if (proration.length) {
        const inv = await this.insertInvoice(c, agency, { kind: 'proration', lines: proration, dueOn: plusDays(day, AGENCY_BILLING.invoiceDueDays), periodStart: day, periodEnd: agency.period_end! });
        invoice = this.presentInvoice(inv, 0);
      }
      for (const ch of changes.filter((x) => x.when === 'now')) {
        await this.life.notify(c, agency, { type: 'agency_addon_activated', grp: 'account', title: 'Add-on activated', body: `${prices[ch.code]!.label} is now on your plan.` });
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.plan_changed', entity: 'agency', entityId: agencyId, payload: { changes, afterNow } }, c);
      return { ...preview, applied: true, invoice };
    });
  }

  // ---------------------------------------------------------------- admin money: overrides, waivers, payouts

  async setPriceOverride(p: Principal, agencyId: string, code: string, amountKobo: number, reason: string) {
    requirePerm(p, 'platform.agencies');
    return this.db.tx(async (c) => {
      const prices = await this.prices(c, agencyId);
      if (!prices[code]) throw new AppError(422, 'validation_failed', 'Choose a fee from the schedule.');
      await c.query(
        `insert into agency_price_overrides (agency_id, code, amount_kobo, reason, set_by) values ($1, $2, $3, $4, $5)
         on conflict (agency_id, code) do update set amount_kobo = excluded.amount_kobo, reason = excluded.reason, set_by = excluded.set_by, created_at = now()`,
        [agencyId, code, amountKobo, reason, p.userId],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'agency.price_override', entity: 'agency', entityId: agencyId, reason, payload: { code, amountKobo, was: prices[code]!.amountKobo } }, c);
      return { code, amountKobo, amount: formatNaira(amountKobo) };
    });
  }

  /** Waive: reason always; above the threshold a second, different approver completes it. */
  async waive(p: Principal, invoiceId: string, reason: string) {
    requirePerm(p, 'platform.money');
    return this.db.tx(async (c) => {
      const inv = (await c.query(`select * from invoices where id = $1 for update`, [invoiceId])).rows[0] as InvoiceRow | undefined;
      if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
      await this.openInvoice(c, inv.agency_id, invoiceId);
      const balance = inv.total_kobo - (await this.paidSoFar(c, inv.id));
      const a = approve({ amountKobo: balance, thresholdKobo: AGENCY_BILLING.secondApprovalAboveKobo, approvals: inv.waive_approvals, approverId: p.userId });
      if (!a.ok) throw new AppError(409, a.code, a.message);
      await this.audit.write(
        { actorId: p.userId, actorRole: 'platform_admin', action: a.complete ? 'invoice.waive_approved' : 'invoice.waive_requested', entity: 'invoice', entityId: invoiceId, reason, payload: { amountKobo: balance, approvals: a.approvals.length } },
        c,
      );
      if (!a.complete) {
        await c.query(`update invoices set waive_approvals = $2, waive_reason = $3 where id = $1`, [invoiceId, a.approvals, reason]);
        return { state: 'awaiting_second_approval' as const, approvals: a.approvals.length, message: 'Waiver recorded. A second approver must confirm.' };
      }
      const done = await this.invoiceTransition(c, invoiceId, 'waive', 'platform_admin', p.userId, { waive_approvals: a.approvals, waive_reason: inv.waive_reason ?? reason, decided_at: new Date() });
      const agency = await this.life.lock(c, inv.agency_id);
      await this.life.notify(c, agency, { type: 'agency_invoice_waived', grp: 'money', title: 'Invoice waived', body: `Invoice ${inv.number} was waived.` });
      await this.afterInvoiceClosed(c, agency, done);
      return { state: done.state, approvals: a.approvals.length };
    });
  }

  /** Payout approval: the destination account must be verified; above the threshold, two people. */
  async approvePayout(p: Principal, payoutId: string) {
    requirePerm(p, 'platform.money');
    const result = await this.db.tx(async (c) => {
      const po = (await c.query(`select * from payouts where id = $1 for update`, [payoutId])).rows[0];
      if (!po) throw new AppError(404, 'not_found', 'Payout not found.');
      if (!['pending', 'awaiting_second_approval'].includes(po.state)) throw new AppError(409, 'invalid_transition', `This payout is ${po.state}.`);
      const bank = await c.query(`select 1 from bank_accounts where owner_type = 'agency' and owner_id = $1 and removed_at is null and verified_at is not null and name_match`, [po.agency_id]);
      if (!bank.rowCount) throw new AppError(422, 'bank_not_verified', agencyCopy.bankNotVerified);
      const a = approve({ amountKobo: po.amount_kobo, thresholdKobo: AGENCY_BILLING.secondApprovalAboveKobo, approvals: po.approved_by, approverId: p.userId });
      if (!a.ok) throw new AppError(409, a.code, a.message);
      const state = a.complete ? 'processing' : 'awaiting_second_approval';
      await c.query(`update payouts set approved_by = $2, state = $3, decided_at = case when $4 then now() else decided_at end where id = $1`, [payoutId, a.approvals, state, a.complete]);
      if (a.complete) await this.payouts.debitSource(c, po);
      await this.audit.write(
        { actorId: p.userId, actorRole: 'platform_admin', action: a.complete ? 'payout.approved' : 'payout.first_approval', entity: 'payout', entityId: payoutId, payload: { amountKobo: po.amount_kobo, approvals: a.approvals.length } },
        c,
      );
      return { state, approvals: a.approvals.length, message: a.complete ? 'Payout approved. The transfer is on its way.' : 'Approval recorded. A second approver must confirm.' };
    });
    // The transfer is queued only once the approval (and the debit) is committed.
    if (result.state === 'processing') result.state = (await this.payouts.send(payoutId)).state;
    return result;
  }
}

function card(p: AgencyPrice) {
  return { code: p.code, name: p.label, amountKobo: p.amountKobo, amount: formatNaira(p.amountKobo), includes: p.includes ?? {} };
}
