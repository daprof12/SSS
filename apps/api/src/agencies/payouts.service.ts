// Money out to an agency's verified bank account (e.g. its bounty pool at offboarding).
// approved → processing (Paystack transfer queued) → paid | failed, from the signed webhook.
// The source wallet is debited at approval; a failed transfer puts the money back.
import { formatNaira, transferFee } from '@erp/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PAYMENTS, type PaymentsAdapter, type TransferEvent } from '../adapters/payments';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { agencyStaff, notify } from '../reports/shared';
import { AgencyLifecycle } from './agency.lifecycle';

export const payoutRef = (id: string) => `payout:${id}`;

@Injectable()
export class PayoutsService {
  private readonly log = new Logger('Payouts');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly life: AgencyLifecycle,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
  ) {}

  /** Debits the source wallet against platform clearing. Call inside the approving transaction. */
  async debitSource(c: Queryable, po: { id: string; amount_kobo: string | number; source_wallet_id: string | null; reason: string | null }) {
    if (!po.source_wallet_id) return;
    const bal = (await c.query(`select coalesce(available_kobo, 0)::bigint as k from wallet_balances where wallet_id = $1`, [po.source_wallet_id])).rows[0];
    if (Number(bal?.k ?? 0) < Number(po.amount_kobo)) {
      throw new AppError(409, 'balance_changed', `The balance is now ${formatNaira(Number(bal?.k ?? 0))}, less than this payout. Ask the agency to request it again.`);
    }
    const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
    const journal = randomUUID();
    await c.query(
      `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values
         ($1, 'withdrawal', -$3::bigint, $4, $5, $6), ($2, 'withdrawal', $3, $4, $5, $6)`,
      [po.source_wallet_id, platform, po.amount_kobo, `${payoutRef(po.id)}:${journal}`, journal, po.reason ?? 'Agency payout'],
    );
  }

  /** Queues the Paystack transfer once the approval has committed. A failure here is recorded, not thrown. */
  async send(payoutId: string): Promise<{ state: string }> {
    const po = (
      await this.db.query(
        `select p.*, b.recipient_code, b.id as bank_id from payouts p
           left join bank_accounts b on b.owner_type = 'agency' and b.owner_id = p.agency_id and b.removed_at is null and b.verified_at is not null and b.name_match
          where p.id = $1`,
        [payoutId],
      )
    ).rows[0];
    if (!po || po.state !== 'processing') return { state: po?.state ?? 'missing' };
    try {
      const { transferCode } = await this.payments.transfer({
        reference: payoutRef(po.id),
        // The bank receives gross minus Paystack's transfer fee (Payout detail: gross, fees, net).
        amountKobo: Number(po.amount_kobo) - transferFee(Number(po.amount_kobo)),
        // The recipient is created when the account is verified; the mock accepts the account id.
        recipientCode: po.recipient_code ?? `RCP_${po.bank_id}`,
        reason: po.reason ?? 'Agency payout',
      });
      await this.db.query(`update payouts set transfer_code = $2 where id = $1`, [po.id, transferCode]);
      return { state: 'processing' };
    } catch (e) {
      this.log.error(`transfer for payout ${po.id} could not start: ${String(e)}`);
      await this.db.tx((c) => this.fail(c, po.id, 'The transfer could not be started. Try again.'));
      return { state: 'failed' };
    }
  }

  /** Signed transfer.* webhook, inside the webhook's transaction. */
  async onTransfer(c: Queryable, ev: TransferEvent) {
    const id = ev.data.reference.startsWith('payout:') ? ev.data.reference.slice('payout:'.length) : null;
    const po = id ? (await c.query(`select * from payouts where id = $1 for update`, [id])).rows[0] : null;
    if (!po) return this.log.warn(`transfer webhook for unknown reference ${ev.data.reference}`);
    if (po.state !== 'processing') return; // already settled; Paystack can resend
    if (ev.event === 'transfer.success') {
      await c.query(`update payouts set state = 'paid', paid_at = now() where id = $1`, [po.id]);
      await notify(c, await agencyStaff(c, po.agency_id), { type: 'payout_paid', grp: 'money', title: 'Payout sent', body: `${formatNaira(Number(po.amount_kobo))} was sent to your bank account.`, link: '/agency/bounties' });
      await this.audit.write({ actorId: null, actorRole: 'system', action: 'payout.paid', entity: 'payout', entityId: po.id, payload: { transferCode: ev.data.transfer_code } }, c);
    } else {
      await this.fail(c, po.id, ev.data.reason || 'The bank did not accept the transfer.');
    }
  }

  private async fail(c: Queryable, payoutId: string, reason: string) {
    const po = (await c.query(`update payouts set state = 'failed', failure_reason = $2 where id = $1 and state = 'processing' returning *`, [payoutId, reason])).rows[0];
    if (!po) return;
    if (po.source_wallet_id) {
      // Put the money back where it came from; the journal stays balanced.
      const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
      const journal = randomUUID();
      await c.query(
        `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values
           ($1, 'withdrawal_reversal', $3, $4, $5, 'Payout failed, money returned'), ($2, 'withdrawal_reversal', -$3::bigint, $4, $5, 'Payout failed, money returned')`,
        [po.source_wallet_id, platform, po.amount_kobo, `${payoutRef(po.id)}:${journal}`, journal],
      );
    }
    await notify(c, await agencyStaff(c, po.agency_id), {
      type: 'payout_failed',
      grp: 'money',
      title: 'Payout failed',
      body: `We could not send ${formatNaira(Number(po.amount_kobo))}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Check your bank account details.`,
      link: '/agency/bounties',
    });
    await this.audit.write({ actorId: null, actorRole: 'system', action: 'payout.failed', entity: 'payout', entityId: po.id, payload: { reason } }, c);
  }

  /** Platform admin: send a failed payout again (after the agency fixed its account). */
  async retry(p: Principal, payoutId: string) {
    this.life.requirePlatformAdmin(p);
    await this.db.tx(async (c) => {
      const po = (await c.query(`select * from payouts where id = $1 for update`, [payoutId])).rows[0];
      if (!po) throw new AppError(404, 'not_found', 'Payout not found.');
      if (po.state !== 'failed') throw new AppError(409, 'invalid_transition', `This payout is ${po.state}.`);
      const bank = await c.query(`select 1 from bank_accounts where owner_type = 'agency' and owner_id = $1 and removed_at is null and verified_at is not null and name_match`, [po.agency_id]);
      if (!bank.rowCount) throw new AppError(422, 'bank_not_verified', 'Verify the account before the next payout.');
      await this.debitSource(c, po);
      await c.query(`update payouts set state = 'processing', failure_reason = null, transfer_code = null where id = $1`, [payoutId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'payout.retry', entity: 'payout', entityId: payoutId }, c);
    });
    return this.send(payoutId);
  }

  /** Platform admin queue ("Donations and payouts" → Payouts) with everything the Payout detail shows. */
  async list(p: Principal, state?: string, thresholdKobo = 0) {
    this.life.requirePlatformAdmin(p);
    const r = await this.db.query(
      `select p.*, a.name as agency, b.bank_name, b.last_four, b.account_name, b.verified_at is not null and b.name_match as bank_ok,
              (select display_name from users where id = p.requested_by) as requested_by_name
         from payouts p join agencies a on a.id = p.agency_id
         left join lateral (select * from bank_accounts where owner_type = 'agency' and owner_id = p.agency_id and removed_at is null order by created_at desc limit 1) b on true
        where ($1::text is null or p.state = $1) order by (p.state in ('pending', 'awaiting_second_approval', 'failed')) desc, p.created_at desc limit 200`,
      [state ?? null],
    );
    return r.rows.map((x) => {
      const gross = Number(x.amount_kobo);
      const fee = transferFee(gross);
      return {
        id: x.id,
        agency: x.agency,
        agencyId: x.agency_id,
        amountKobo: gross,
        feeKobo: fee,
        netKobo: gross - fee,
        state: x.state,
        reason: x.reason,
        requestedBy: x.requested_by_name,
        approvals: x.approved_by.length,
        approvalsNeeded: gross > thresholdKobo ? 2 : 1,
        approvedByMe: x.approved_by.includes(p.userId),
        destination: x.bank_name ? { bank: x.bank_name, lastFour: x.last_four, name: x.account_name, verified: !!x.bank_ok } : null,
        holdNote: x.hold_note,
        failureReason: x.failure_reason,
        transferCode: x.transfer_code,
        createdAt: x.created_at,
        decidedAt: x.decided_at,
        paidAt: x.paid_at,
      };
    });
  }

  /** "Hold needs a note": stops a payout before it is sent, e.g. while a dispute is checked. */
  async hold(p: Principal, payoutId: string, note: string) {
    this.life.requirePlatformAdmin(p);
    const r = await this.db.query(`update payouts set state = 'held', hold_note = $2 where id = $1 and state in ('pending', 'awaiting_second_approval', 'failed') returning id`, [payoutId, note]);
    if (!r.rowCount) throw new AppError(409, 'invalid_transition', 'Only a payout that has not been sent can be held.');
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'payout.hold', entity: 'payout', entityId: payoutId, reason: note });
    return { state: 'held', message: 'Payout held.' };
  }

  /** Back to the approval queue; earlier approvals no longer count. */
  async release(p: Principal, payoutId: string) {
    this.life.requirePlatformAdmin(p);
    const r = await this.db.query(`update payouts set state = 'pending', approved_by = '{}', hold_note = null where id = $1 and state = 'held' returning id`, [payoutId]);
    if (!r.rowCount) throw new AppError(409, 'invalid_transition', 'This payout is not held.');
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'payout.release', entity: 'payout', entityId: payoutId });
    return { state: 'pending', message: 'Released. It needs approval again.' };
  }
}
