// Home plans and billing (B4; boards "Subscription and payment", "Payment problem", "Installation team").
// Subscribe: pay the install fee and the first month → install job → booked → installed (devices
// created, first period starts then). Each month: charge; a failed charge starts dunning, whose stage
// follows the days since it failed. Paying at any time restores everything the same day.
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { applyEvent, DUNNING, dunningStage, firstPayment, formatNaira, subscriptionMachine } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PAYMENTS, type PaymentsAdapter } from '../adapters/payments';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { WithdrawalsService } from '../wallet/withdrawals.service';
import { payFromWallet, replayed, spendable, startCharge, type PayWith } from './money';

const day = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const platformFees = async (c: Queryable) => (await c.query(`select id from wallets where owner_type = 'platform_fees' and owner_id is null`)).rows[0].id as string;
const admins = async (c: Queryable) => (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id as string);
const daysSince = (d: Date | string) => Math.floor((Date.now() - +new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000) + 1;

@Injectable()
export class BillingService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  async plans() {
    const r = await this.db.query(`select * from plans where audience in ('household', 'community') and active order by price_kobo`);
    return r.rows.map((p) => {
      const d = p.devices_included ?? {};
      const parts = [d.camera && `${d.camera} ${d.camera === 1 ? 'camera' : 'cameras'}`, d.street_light && `${d.street_light} street ${d.street_light === 1 ? 'light' : 'lights'}`].filter(Boolean);
      return {
        code: p.code,
        name: p.name,
        audience: p.audience,
        priceKobo: Number(p.price_kobo),
        installFeeKobo: Number(p.install_fee_kobo),
        line: p.audience === 'community' ? 'Shared devices for a street or estate' : `${parts.join(', ')}${p.code === 'household_plus' ? ', family members' : ', incident briefs'}`,
        devices: d,
      };
    });
  }

  private async ownedProperty(c: Queryable, userId: string): Promise<string> {
    const own = (await c.query(`select id from properties where owner_id = $1 limit 1`, [userId])).rows[0];
    if (own) return own.id;
    const member = await c.query(`select 1 from property_members where user_id = $1`, [userId]);
    if (member.rowCount) throw new AppError(409, 'member_of_home', 'You are a member of another home. Leave it to start your own plan.');
    const home = (await c.query(`select location_id from saved_places where user_id = $1 and is_home`, [userId])).rows[0];
    if (!home) throw new AppError(422, 'home_required', 'Set your home building first in Home and places.');
    return (await c.query(`insert into properties (owner_id, location_id, ownership) values ($1, $2, 'owner') returning id`, [userId, home.location_id])).rows[0].id;
  }

  /** "Pay with Paystack" (or the wallet) on "Protect your home": install fee and first month today. */
  async subscribe(p: Principal, b: { planCode: string; method: PayWith; pin?: string }, key: string) {
    const prior = await replayed(this.db.pool, key, p.userId);
    if (prior) return prior;
    const plan = (await this.plans()).find((x) => x.code === b.planCode);
    if (!plan) throw new AppError(422, 'validation_failed', 'Choose a plan.', { fields: [{ field: 'planCode', message: 'Choose a plan.' }] });
    const total = firstPayment(plan);
    if (b.method === 'wallet') {
      if (!b.pin) throw new AppError(422, 'pin_required', 'Enter your PIN to pay from your wallet.', { fields: [{ field: 'pin', message: 'Enter your PIN.' }] });
      await this.withdrawals.verifyPin(p.userId, b.pin);
    }
    const subId = await this.db.tx(async (c) => {
      const property = await this.ownedProperty(c, p.userId);
      const live = (await c.query(`select id, state from subscriptions where property_id = $1 and state <> 'cancelled' order by created_at desc limit 1`, [property])).rows[0];
      if (live && live.state !== 'draft') throw new AppError(409, 'already_subscribed', 'This home already has a plan. See it in My home devices.');
      if (live) {
        await c.query(`update subscriptions set plan_code = $2 where id = $1`, [live.id, plan.code]);
        return live.id as string;
      }
      return (await c.query(`insert into subscriptions (owner_id, property_id, plan_code, state) values ($1, $2, $3, 'draft') returning id`, [p.userId, property, plan.code])).rows[0].id as string;
    });
    if (b.method !== 'wallet') {
      return { ...(await startCharge(this.db, this.payments, { userId: p.userId, purpose: 'install', purposeRef: subId, amountKobo: total, method: b.method, key })), subscriptionId: subId };
    }
    return this.db.tx(async (c) => {
      const paid = await payFromWallet(c, { userId: p.userId, purpose: 'install', purposeRef: subId, amountKobo: total, key, ledgerType: 'payment', memo: `${plan.name} plan: install and first month` });
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'payment', $2, $3, $4, $5)`, [
        await platformFees(c),
        total,
        paid.reference,
        paid.journal,
        `${plan.name} plan`,
      ]);
      await onInstallPaid(c, subId);
      return { state: 'succeeded', reference: paid.reference, receiptNo: paid.receiptNo, subscriptionId: subId, message: `Paid ${formatNaira(total)}. We will call you to book the install.` };
    });
  }

  /** Board "Payment problem": what is due, which stage, what happens next. */
  async billing(p: Principal) {
    const s = (
      await this.db.query(
        `select s.*, pl.name, pl.price_kobo, d.due_since, d.amount_kobo as due_kobo, d.attempts, d.arrangement, d.next_action_at
           from subscriptions s join plans pl on pl.code = s.plan_code join properties pr on pr.id = s.property_id
           left join dunning_state d on d.subscription_id = s.id
          where pr.owner_id = $1 and s.state <> 'cancelled' order by s.created_at desc limit 1`,
        [p.userId],
      )
    ).rows[0];
    if (!s) return { plan: null };
    const job = (await this.db.query(`select id, number, state, scheduled_at, visit_window from install_jobs where subscription_id = $1 and kind = 'install' order by created_at desc limit 1`, [s.id])).rows[0];
    const late = ['grace', 'extras_paused', 'sharing_paused', 'switched_off'].includes(s.state);
    const dayN = late && s.due_since ? daysSince(s.due_since) : null;
    return {
      plan: { name: s.name, priceKobo: Number(s.price_kobo) },
      state: s.state,
      paidUntil: s.next_bill_at,
      lastPaidAt: s.last_paid_at,
      autopayFromWallet: s.autopay_from_wallet,
      install: job ? { number: job.number, state: job.state, visit: job.scheduled_at ? `${day(job.scheduled_at)}, ${job.visit_window ?? ''}`.replace(/, $/, '') : null } : null,
      problem: late
        ? {
            amountKobo: Number(s.due_kobo ?? s.price_kobo),
            dueSince: s.due_since,
            day: dayN,
            stages: DUNNING.stages.map((x) => ({ ...x, current: x.state === s.state })),
            arrangement: s.arrangement,
            walletKobo: await spendable(this.db.pool, p.userId),
          }
        : null,
    };
  }

  /** Pay what is due: Paystack, or the wallet with the PIN. */
  async payDue(p: Principal, b: { method: PayWith; pin?: string }, key: string) {
    const prior = await replayed(this.db.pool, key, p.userId);
    if (prior) return prior;
    const s = (
      await this.db.query(
        `select s.id, s.state, pl.price_kobo, pl.name, d.amount_kobo from subscriptions s join plans pl on pl.code = s.plan_code join properties pr on pr.id = s.property_id
           left join dunning_state d on d.subscription_id = s.id where pr.owner_id = $1 and s.state in ('grace', 'extras_paused', 'sharing_paused', 'switched_off') limit 1`,
        [p.userId],
      )
    ).rows[0];
    if (!s) throw new AppError(409, 'nothing_due', 'Nothing is due. Your plan is paid up.');
    const amount = Number(s.amount_kobo ?? s.price_kobo);
    if (b.method !== 'wallet') return startCharge(this.db, this.payments, { userId: p.userId, purpose: 'subscription', purposeRef: s.id, amountKobo: amount, method: b.method, key });
    if (!b.pin) throw new AppError(422, 'pin_required', 'Enter your PIN to pay from your wallet.', { fields: [{ field: 'pin', message: 'Enter your PIN.' }] });
    await this.withdrawals.verifyPin(p.userId, b.pin);
    return this.db.tx(async (c) => {
      const paid = await payFromWallet(c, { userId: p.userId, purpose: 'subscription', purposeRef: s.id, amountKobo: amount, key, ledgerType: 'payment', memo: `${s.name} plan, monthly` });
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'payment', $2, $3, $4, $5)`, [await platformFees(c), amount, paid.reference, paid.journal, `${s.name} plan`]);
      await onMonthPaid(c, s.id);
      return { state: 'succeeded', reference: paid.reference, receiptNo: paid.receiptNo, message: `Paid ${formatNaira(amount)}. Everything is back on.` };
    });
  }

  /** "Need more time? Ask for a payment plan": recorded, staff call back; the stages keep running until agreed. */
  async askPlan(p: Principal, note?: string) {
    return this.db.tx(async (c) => {
      const s = (
        await c.query(
          `select s.id from subscriptions s join properties pr on pr.id = s.property_id join dunning_state d on d.subscription_id = s.id where pr.owner_id = $1 limit 1`,
          [p.userId],
        )
      ).rows[0];
      if (!s) throw new AppError(409, 'nothing_due', 'Nothing is due.');
      await c.query(`update dunning_state set arrangement = 'payment_plan', arrangement_note = $2 where subscription_id = $1`, [s.id, note?.trim() || null]);
      let number = '';
      for (;;) {
        number = `S-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from support_tickets where number = $1`, [number])).rowCount) break;
      }
      await c.query(`insert into support_tickets (number, user_id, topic, body, related_id) values ($1, $2, 'money', $3, $4)`, [number, p.userId, `Payment plan asked for the home plan.${note?.trim() ? ` ${note.trim()}` : ''}`, s.id]);
      await notify(c, await admins(c), { type: 'payment_plan', grp: 'money', title: 'Payment plan asked', body: `${number}: a household asked for more time to pay.`, link: '/admin/support' });
      return { message: `Asked. We will call you within a working day. Reference ${number}.` };
    });
  }

  async setAutopay(p: Principal, on: boolean) {
    const r = await this.db.query(`update subscriptions s set autopay_from_wallet = $2 from properties pr where pr.id = s.property_id and pr.owner_id = $1 and s.state <> 'cancelled'`, [p.userId, on]);
    if (!r.rowCount) throw new AppError(404, 'no_plan', 'You have no plan.');
    return { message: on ? 'Monthly payments come from your wallet first.' : 'Monthly payments use your card.' };
  }

  // ---------------------------------------------------------------- jobs

  /** Monthly charge for active plans that are due: the wallet when the owner chose it and it has enough; else the card on file. */
  async billDue(failCard = true): Promise<{ charged: number; failed: number }> {
    return this.db.tx(async (c) => {
      const due = await c.query(
        `select s.id, s.owner_id, s.autopay_from_wallet, pl.price_kobo, pl.name from subscriptions s join plans pl on pl.code = s.plan_code
          where s.state = 'active' and s.next_bill_at <= now() for update of s skip locked`,
      );
      let charged = 0;
      let failed = 0;
      for (const s of due.rows) {
        const amount = Number(s.price_kobo);
        if (s.autopay_from_wallet && (await spendable(c, s.owner_id)) >= amount) {
          const paid = await payFromWallet(c, { userId: s.owner_id, purpose: 'subscription', purposeRef: s.id, amountKobo: amount, key: `autopay-${s.id}-${Date.now()}`, ledgerType: 'payment', memo: `${s.name} plan, monthly` });
          await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'payment', $2, $3, $4, $5)`, [await platformFees(c), amount, paid.reference, paid.journal, `${s.name} plan`]);
          await onMonthPaid(c, s.id);
          charged++;
          continue;
        }
        // No saved card authorisation in this build: Paystack's charge_authorization replaces this.
        if (!failCard) continue;
        await chargeFailed(c, s.id, amount);
        failed++;
      }
      return { charged, failed };
    });
  }

  /** Moves late plans to the stage their day says; each move is logged and the owner is told. */
  async advanceDunning(): Promise<number> {
    return this.db.tx(async (c) => {
      const rows = await c.query(
        `select s.id, s.state, s.owner_id, d.due_since from subscriptions s join dunning_state d on d.subscription_id = s.id
          where s.state in ('grace', 'extras_paused', 'sharing_paused') for update of s skip locked`,
      );
      let moved = 0;
      for (const s of rows.rows) {
        const want = dunningStage(daysSince(s.due_since));
        if (want === s.state) continue;
        let cur = s.state;
        while (cur !== want) {
          const r = applyEvent(subscriptionMachine, cur, 'stage_advance', 'system');
          if (!r.ok) break;
          cur = r.to;
        }
        await c.query(`update subscriptions set state = $2 where id = $1`, [s.id, cur]);
        await c.query(`update dunning_state set stage = $2 where subscription_id = $1`, [s.id, cur]);
        const stage = DUNNING.stages.find((x) => x.state === cur)!;
        await notify(c, [s.owner_id], { type: 'dunning_stage', grp: 'money', title: 'Home plan payment', body: `Payment still not received: ${stage.title}. ${stage.line}`, link: '/profile/home/billing' });
        await this.audit.write({ actorId: null, actorRole: 'system', action: 'subscription.dunning', entity: 'subscription', entityId: s.id, payload: { to: cur } }, c);
        moved++;
      }
      return moved;
    });
  }

  // ---------------------------------------------------------------- platform admin: installs

  private admin(p: Principal) {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  async installs(p: Principal, f?: LocationFilter) {
    this.admin(p);
    const args: unknown[] = [];
    const where = locationWhere(f, args);
    const r = await this.db.query(
      `select j.id, j.number, j.state, j.scheduled_at, j.visit_window, j.created_at, s.id as sub_id, s.state as sub_state, pl.name as plan, pl.devices_included,
              u.display_name as owner, l.postcode, l.address_text, tu.display_name as tech
         from install_jobs j join subscriptions s on s.id = j.subscription_id join plans pl on pl.code = s.plan_code
         join properties pr on pr.id = j.property_id join users u on u.id = pr.owner_id join locations l on l.id = pr.location_id
         left join users tu on tu.id = j.technician_id
        where j.kind = 'install' and (j.state <> 'done' or j.created_at > now() - interval '14 days') and ${where} order by j.state = 'done', j.created_at`,
      args,
    );
    return r.rows.map((j) => ({
      id: j.id,
      number: j.number,
      state: j.state,
      plan: j.plan,
      devices: j.devices_included,
      owner: j.owner,
      address: `${j.address_text}, ${j.postcode}`,
      visit: j.scheduled_at ? `${day(j.scheduled_at)}, ${j.visit_window ?? ''}` : null,
      technician: j.tech,
      at: j.created_at,
    }));
  }

  /** Book the install visit, then mark installed: devices are added and the first month starts. */
  async installAct(p: Principal, id: string, b: { action: 'book' | 'installed'; scheduledAt?: string; window?: string; technicianId?: string }) {
    this.admin(p);
    return this.db.tx(async (c) => {
      const j = (
        await c.query(
          `select j.*, s.state as sub_state, pl.devices_included, pl.name as plan, pr.owner_id, pr.location_id from install_jobs j join subscriptions s on s.id = j.subscription_id
             join plans pl on pl.code = s.plan_code join properties pr on pr.id = j.property_id where j.id = $1 and j.kind = 'install' for update of j`,
          [id],
        )
      ).rows[0];
      if (!j) throw new AppError(404, 'not_found', 'Install not found.');
      if (b.action === 'book') {
        if (!b.scheduledAt || !b.window) throw new AppError(422, 'validation_failed', 'Choose a date and a time window.');
        const tech = b.technicianId ?? (await c.query(`select user_id from technicians where active order by vetted_at limit 1`)).rows[0]?.user_id;
        await c.query(`update install_jobs set state = 'scheduled', scheduled_at = $2, visit_window = $3, technician_id = $4, booked_at = now() where id = $1`, [id, b.scheduledAt, b.window, tech]);
        if (j.sub_state === 'install_pending') await c.query(`update subscriptions set state = 'install_booked' where id = $1`, [j.subscription_id]);
        await notify(c, [j.owner_id], { type: 'install_booked', grp: 'account', title: 'Install booked', body: `${j.number}: ${day(b.scheduledAt)}, ${b.window}. The technician shows a badge and a code; never let anyone in without both.`, link: '/profile/home/devices' });
        return { message: 'Install booked.' };
      }
      if (j.state === 'done') throw new AppError(409, 'done', 'Already installed.');
      if (j.state !== 'scheduled') throw new AppError(409, 'not_booked', 'Book the visit first.');
      const d = j.devices_included ?? {};
      const serial = () => `${Date.now().toString(36).toUpperCase()}${randomInt(1000, 9999)}`;
      for (let i = 1; i <= (d.camera ?? 0); i++) {
        await c.query(`insert into devices (property_id, location_id, type, serial, name, status, last_seen) values ($1, $2, 'camera', $3, $4, 'online', now())`, [j.property_id, j.location_id, `CAM-${serial()}`, i === 1 ? 'Front gate camera' : `Camera ${i}`]);
      }
      for (let i = 1; i <= (d.street_light ?? 0); i++) {
        await c.query(`insert into devices (property_id, location_id, type, serial, name, status, last_seen, battery_pct) values ($1, $2, 'street_light', $3, $4, 'online', now(), 100)`, [j.property_id, j.location_id, `SL-${serial()}`, i === 1 ? 'Street light, outside' : `Street light ${i}`]);
      }
      await c.query(`update install_jobs set state = 'done', fixed_at = now(), confirmed_at = now() where id = $1`, [id]);
      // Decided 2026-10-17: billing starts at install. The first month was paid with the install fee.
      await c.query(`update subscriptions set state = 'active', period_start = now(), next_bill_at = now() + interval '1 month', last_paid_at = coalesce(last_paid_at, now()) where id = $1`, [j.subscription_id]);
      await notify(c, [j.owner_id], { type: 'install_done', grp: 'account', title: 'Your devices are on', body: `${j.plan} plan is active. Open My home devices to see your cameras and lights.`, link: '/profile/home/devices' });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'install.done', entity: 'install_job', entityId: id }, c);
      return { message: 'Installed. The plan is active and the first month starts today.' };
    });
  }
}

/** Install fee and first month received (wallet or webhook): the job is created for the team to book. */
export async function onInstallPaid(c: Queryable, subId: string) {
  const s = (await c.query(`select s.*, pl.name from subscriptions s join plans pl on pl.code = s.plan_code where s.id = $1 for update of s`, [subId])).rows[0];
  if (!s || s.state !== 'draft') return;
  await c.query(`update subscriptions set state = 'install_pending', last_paid_at = now() where id = $1`, [subId]);
  let number = '';
  for (;;) {
    number = `IN-${randomInt(100000, 1000000)}`;
    if (!(await c.query(`select 1 from install_jobs where number = $1`, [number])).rowCount) break;
  }
  await c.query(`insert into install_jobs (kind, property_id, subscription_id, number, reported_by) values ('install', $1, $2, $3, $4)`, [s.property_id, subId, number, s.owner_id]);
  await notify(c, [s.owner_id], { type: 'install_paid', grp: 'money', title: 'Plan paid', body: `${s.name} plan paid. We will call you to book the install (${number}). Billing starts when it is installed.`, link: '/profile/home' });
  await notify(c, await admins(c), { type: 'install_new', grp: 'account', title: 'New install', body: `${number}: ${s.name} plan to install.`, link: '/admin/repairs' });
}

/** A month paid (wallet, webhook or autopay): back to active, next bill a month on, dunning cleared. */
export async function onMonthPaid(c: Queryable, subId: string) {
  const s = (await c.query(`select state, owner_id from subscriptions where id = $1 for update`, [subId])).rows[0];
  if (!s) return;
  const wasLate = ['grace', 'extras_paused', 'sharing_paused', 'switched_off'].includes(s.state);
  await c.query(
    `update subscriptions set state = case when state in ('grace', 'extras_paused', 'sharing_paused', 'switched_off') then 'active' else state end,
            next_bill_at = greatest(coalesce(next_bill_at, now()), now()) + interval '1 month', last_paid_at = now() where id = $1`,
    [subId],
  );
  await c.query(`delete from dunning_state where subscription_id = $1`, [subId]);
  if (wasLate) await notify(c, [s.owner_id], { type: 'plan_restored', grp: 'money', title: 'Payment received', body: 'Thank you. Everything on your home plan is back on.', link: '/profile/home/devices' });
}

/** The monthly charge failed: day 1 of dunning. */
export async function chargeFailed(c: Queryable, subId: string, amountKobo: number, dueSince?: string) {
  const s = (await c.query(`select state, owner_id from subscriptions where id = $1`, [subId])).rows[0];
  const r = applyEvent(subscriptionMachine, s.state, 'charge_failed', 'system');
  if (!r.ok) return;
  await c.query(`update subscriptions set state = 'grace' where id = $1`, [subId]);
  await c.query(
    `insert into dunning_state (subscription_id, stage, due_since, next_action_at, attempts, amount_kobo) values ($1, 'grace', coalesce($3::date, current_date), now() + interval '1 day', 1, $2)
     on conflict (subscription_id) do update set stage = 'grace', due_since = excluded.due_since, attempts = dunning_state.attempts + 1, amount_kobo = excluded.amount_kobo`,
    [subId, amountKobo, dueSince ?? null],
  );
  await notify(c, [s.owner_id], {
    type: 'payment_failed',
    grp: 'money',
    title: 'Payment problem',
    body: `We could not take ${formatNaira(amountKobo)} for your home plan. Everything keeps working for 7 days. Pay now to avoid any pause.`,
    link: '/profile/home/billing',
  });
}

