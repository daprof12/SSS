// Fund wallet — UX Gap Analysis §9. Credit happens only in handleWebhook.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { checkFund, formatNaira, kobo } from '@erp/domain';
import { PAYMENTS, newReference, type ChargeEvent, type PayMethod, type PaymentsAdapter, type TransferEvent } from '../adapters/payments';
import { PayoutsService } from '../agencies/payouts.service';
import { WithdrawalsService } from './withdrawals.service';
import { AgencyBillingService } from '../agencies/billing.service';
import { creditPool, poolFundFailed } from '../reports/bounties.service';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

export { WALLET_LIMITS } from './limits';
import { WALLET_LIMITS } from './limits';

@Injectable()
export class WalletService {
  private readonly log = new Logger('Wallet');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(AgencyBillingService) private readonly agencyBilling: AgencyBillingService,
    @Inject(PayoutsService) private readonly payouts: PayoutsService,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  async walletId(userId: string, c: Queryable = this.db.pool): Promise<string> {
    const r = await c.query(
      `insert into wallets (owner_type, owner_id) values ('user', $1)
       on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`,
      [userId],
    );
    return r.rows[0].id;
  }

  async summary(userId: string, tab: 'all' | 'money_in' | 'money_out' | 'rewards' | 'bounties' | 'payments' | 'withdrawals' = 'all') {
    const id = await this.walletId(userId);
    const bal = (await this.db.query(`select available_kobo, held_kobo from wallet_balances where wallet_id = $1`, [id])).rows[0];
    const filter: Record<string, string> = {
      all: 'true',
      money_in: 'l.amount_kobo > 0',
      money_out: 'l.amount_kobo < 0',
      rewards: `l.type = 'reward'`,
      bounties: `l.type = 'bounty'`,
      payments: `l.type in ('payment', 'fine', 'donation_out')`,
      withdrawals: `l.type in ('withdrawal', 'withdrawal_reversal')`,
    };
    const entries = await this.db.query(
      `select l.id, l.type, l.amount_kobo, l.available_at, l.reference, l.memo, l.created_at
         from wallet_ledger l where l.wallet_id = $1 and ${filter[tab]} order by l.id desc limit 50`,
      [id],
    );
    const pending = await this.db.query(
      `select provider_ref as reference, amount_kobo, method, created_at from payments
        where user_id = $1 and purpose = 'wallet_fund' and state in ('initiated', 'pending') order by created_at desc limit 5`,
      [userId],
    );
    const bank = (
      await this.db.query(
        `select bank_name, last_four, name_match from bank_accounts where owner_type = 'user' and owner_id = $1 and removed_at is null order by created_at desc limit 1`,
        [userId],
      )
    ).rows[0];
    return {
      walletId: id,
      availableKobo: bal.available_kobo,
      heldKobo: bal.held_kobo,
      available: formatNaira(bal.available_kobo),
      held: formatNaira(bal.held_kobo),
      bank: bank ? { bankName: bank.bank_name, lastFour: bank.last_four, nameMatches: bank.name_match } : null,
      pendingFunding: pending.rows.map((r) => ({ reference: r.reference, amountKobo: r.amount_kobo, method: r.method, since: r.created_at })),
      entries: entries.rows.map((e) => ({
        id: e.id,
        type: e.type,
        amountKobo: e.amount_kobo,
        amount: formatNaira(e.amount_kobo, { sign: true }),
        held: new Date(e.available_at) > new Date(),
        availableAt: e.available_at,
        reference: e.reference,
        memo: e.memo,
        at: e.created_at,
      })),
      limits: WALLET_LIMITS,
    };
  }

  /** Steps 0–3 of the fund flow: gate, validate, create payment, hand off to Paystack. */
  async startFunding(p: Principal, amountKobo: number, method: PayMethod, idempotencyKey: string) {
    const prior = await this.db.query(`select user_id, provider_ref, state, amount_kobo, method from payments where idempotency_key = $1`, [idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].user_id !== p.userId) throw new AppError(409, 'idempotency_conflict', 'Try again.');
      return { reference: prior.rows[0].provider_ref, state: prior.rows[0].state, replayed: true };
    }

    const kyc = await this.db.query(`select 1 from kyc_verifications where user_id = $1 and status = 'verified' limit 1`, [p.userId]);
    if (!kyc.rowCount) throw new AppError(403, 'kyc_required', 'Verify your identity to use your wallet.');

    const wallet = await this.db.query(`select status from wallets where owner_type = 'user' and owner_id = $1`, [p.userId]);
    if (wallet.rows[0] && wallet.rows[0].status !== 'active') {
      throw new AppError(403, 'wallet_frozen', 'Your wallet is on hold. Contact support.');
    }

    const check = checkFund(kobo(amountKobo), WALLET_LIMITS);
    if (!check.ok) throw new AppError(422, 'validation_failed', check.message, { fields: [{ field: check.field, message: check.message }] });

    const user = (await this.db.query(`select email, phone from users where id = $1`, [p.userId])).rows[0];
    const reference = newReference('fund');
    await this.db.query(
      `insert into payments (user_id, purpose, amount_kobo, method, provider_ref, idempotency_key, state) values ($1, 'wallet_fund', $2, $3, $4, $5, 'pending')`,
      [p.userId, amountKobo, method, reference, idempotencyKey],
    );
    const init = await this.payments.initialize({
      reference,
      amountKobo,
      method,
      email: user.email ?? `${String(user.phone).replace('+', '')}@sms.erp.local`,
      metadata: { purpose: 'wallet_fund', userId: p.userId },
    });
    return { ...init, state: 'pending' as const, amount: formatNaira(amountKobo) };
  }

  async paymentStatus(p: Principal, reference: string) {
    const r = await this.db.query(
      `select provider_ref, state, amount_kobo, method, failure_reason, paid_at, created_at from payments where provider_ref = $1 and user_id = $2`,
      [reference, p.userId],
    );
    const x = r.rows[0];
    if (!x) throw new AppError(404, 'not_found', 'Payment not found.');
    const message: Record<string, string> = {
      pending: 'Confirming your payment.',
      initiated: 'Confirming your payment.',
      succeeded: `${formatNaira(x.amount_kobo)} was added to your wallet.`,
      failed: 'Your card was not charged. Try again or use another card.',
      abandoned: 'Payment not finished.',
    };
    return { reference: x.provider_ref, state: x.state, amountKobo: x.amount_kobo, method: x.method, reason: x.failure_reason, paidAt: x.paid_at, message: message[x.state] ?? '' };
  }

  /** Step 4: signed webhook → ledger. Idempotent on Paystack event id and reference. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ ok: true; duplicate?: boolean }> {
    if (!this.payments.verifySignature(rawBody, signature)) throw new AppError(401, 'bad_signature', 'Invalid signature.');
    const event = JSON.parse(rawBody.toString('utf8')) as ChargeEvent | TransferEvent;

    return this.db.tx(async (c) => {
      const stored = await c.query(
        `insert into webhook_events (provider, event_id, event_type, payload) values ('paystack', $1, $2, $3) on conflict do nothing returning event_id`,
        [String(event.data.id), event.event, event],
      );
      if (!stored.rowCount) return { ok: true as const, duplicate: true };
      if (event.event.startsWith('transfer.')) {
        const tr = event as TransferEvent;
        if (tr.data.reference.startsWith('wd:')) await this.withdrawals.onTransfer(c, tr);
        else await this.payouts.onTransfer(c, tr);
        await c.query(`update webhook_events set processed_at = now() where provider = 'paystack' and event_id = $1`, [String(event.data.id)]);
        return { ok: true as const };
      }

      const charge = event as ChargeEvent;
      const pay = (await c.query(`select * from payments where provider_ref = $1 for update`, [charge.data.reference])).rows[0];
      if (!pay) {
        this.log.warn(`webhook for unknown reference ${charge.data.reference}`);
      } else if (charge.event === 'charge.success' && pay.state !== 'succeeded') {
        // Credit what actually arrived (transfers can differ from the amount typed).
        const amount = charge.data.amount;
        await c.query(`update payments set state = 'succeeded', paid_at = now(), amount_kobo = $2, method = coalesce(method, $3) where id = $1`, [pay.id, amount, mapChannel(charge.data.channel)]);
        if (pay.purpose === 'wallet_fund') {
          const userWallet = await this.walletId(pay.user_id, c);
          const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
          const journal = randomUUID();
          await c.query(
            `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values
               ($1, 'fund', $3, $4, $5, $6), ($2, 'fund', -$3::bigint, $4, $5, $6)`,
            [userWallet, platform, amount, pay.provider_ref, journal, `Funded by ${{ card: 'card', bank_transfer: 'bank transfer', ussd: 'USSD' }[mapChannel(charge.data.channel)]}`],
          );
          await c.query(
            `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'wallet_funded', 'money', 'in_app', 'Wallet funded', $2, '/wallet')`,
            [pay.user_id, `${formatNaira(amount)} was added to your wallet.`],
          );
        } else if (pay.purpose === 'agency_invoice') {
          await this.agencyBilling.onPaystackSuccess(c, pay, amount);
        } else if (pay.purpose === 'bounty_pool') {
          await creditPool(c, pay, amount, randomUUID(), { card: 'card', bank_transfer: 'bank transfer', ussd: 'USSD' }[mapChannel(charge.data.channel)]);
        }
        await this.audit.write({ actorId: null, actorRole: 'system', action: 'payment.succeeded', entity: 'payment', entityId: pay.id, payload: { amount, reference: pay.provider_ref } }, c);
      } else if (charge.event === 'charge.failed' && pay.state !== 'succeeded') {
        await c.query(`update payments set state = 'failed', failure_reason = $2 where id = $1`, [pay.id, charge.data.gateway_response]);
        if (pay.purpose === 'agency_invoice') {
          await this.agencyBilling.onPaystackFailed(c, pay);
        } else if (pay.purpose === 'bounty_pool') {
          await poolFundFailed(c, pay);
        } else {
          await c.query(
            `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'wallet_fund_failed', 'money', 'in_app', 'Funding failed', 'Your card was not charged. Try again or use another card.', '/wallet')`,
            [pay.user_id],
          );
        }
      }
      await c.query(`update webhook_events set processed_at = now() where provider = 'paystack' and event_id = $1`, [String(event.data.id)]);
      return { ok: true as const };
    });
  }
}

function mapChannel(channel: string): 'card' | 'bank_transfer' | 'ussd' {
  if (channel === 'dedicated_nuban' || channel === 'bank_transfer' || channel === 'bank') return 'bank_transfer';
  if (channel === 'ussd') return 'ussd';
  return 'card';
}
