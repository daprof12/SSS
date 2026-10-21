// Money out to a bank account in the person's verified name (Rewards doc "Wallet"; States doc
// withdraw flow). requested → held_first (first one waits) → processing (Paystack transfer) →
// sent → arrived, or failed_refunded with the money back in the wallet.
import {
  applyEvent,
  bankName,
  checkPin,
  checkWithdrawal,
  formatNaira,
  isNuban,
  kobo,
  namesMatch,
  transferFee,
  WITHDRAWAL_RULES,
  withdrawalMachine,
} from '@erp/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { PAYMENTS, type PaymentsAdapter, type TransferEvent } from '../adapters/payments';
import { AuthService } from '../auth/auth.service';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { CONFIG, type AppConfig } from '../core/config';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { WALLET_LIMITS } from './limits';

const ref = (id: string) => `wd:${id}`;
const when = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

@Injectable()
export class WithdrawalsService {
  private readonly log = new Logger('Withdrawals');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // ---------------------------------------------------------------- identity, PIN

  /** The verified name from the identity check. Withdrawals need it (KYC). */
  private async verified(userId: string, c: Queryable = this.db.pool): Promise<string> {
    const r = (
      await c.query(
        `select coalesce(k.full_name, u.display_name) as name from kyc_verifications k join users u on u.id = k.user_id
          where k.user_id = $1 and k.status = 'verified' order by k.verified_at desc limit 1`,
        [userId],
      )
    ).rows[0];
    if (!r) throw new AppError(403, 'kyc_required', 'Verify your identity to use your wallet.');
    return r.name as string;
  }

  private hashPin(pin: string) {
    const salt = randomBytes(16).toString('hex');
    return `scrypt$${salt}$${scryptSync(`${pin}:${this.config.otpSecret}`, salt, 32).toString('hex')}`;
  }

  async pinStatus(p: Principal) {
    const u = (await this.db.query(`select pin_hash is not null as set, pin_locked_until, pin_reset_at from users where id = $1`, [p.userId])).rows[0];
    const resetHold = u.pin_reset_at && Date.now() - +new Date(u.pin_reset_at) < WITHDRAWAL_RULES.firstHoldHours * 3600_000 ? new Date(+new Date(u.pin_reset_at) + WITHDRAWAL_RULES.firstHoldHours * 3600_000) : null;
    return { set: u.set as boolean, resetHoldUntil: resetHold, lockedUntil: u.pin_locked_until && new Date(u.pin_locked_until) > new Date() ? u.pin_locked_until : null, length: WITHDRAWAL_RULES.pinLength };
  }

  async setPin(p: Principal, b: { pin: string; currentPin?: string }) {
    const u = (await this.db.query(`select pin_hash from users where id = $1`, [p.userId])).rows[0];
    if (u.pin_hash) {
      if (!b.currentPin) throw new AppError(422, 'validation_failed', 'Enter your current PIN.', { fields: [{ field: 'currentPin', message: 'Enter your current PIN.' }] });
      await this.verifyPin(p.userId, b.currentPin);
    }
    const bad = checkPin(b.pin);
    if (bad) throw new AppError(422, 'validation_failed', bad, { fields: [{ field: 'pin', message: bad }] });
    await this.db.query(`update users set pin_hash = $2, pin_failed = 0, pin_locked_until = null where id = $1`, [p.userId, this.hashPin(b.pin)]);
    await this.audit.write({ actorId: p.userId, action: u.pin_hash ? 'wallet.pin_changed' : 'wallet.pin_set', entity: 'user', entityId: p.userId });
    return { set: true, message: u.pin_hash ? 'PIN changed.' : 'PIN set. You will use it for every withdrawal.' };
  }

  /** Forgot PIN, step 1: a code by SMS to the account's own phone. Works while the PIN is locked. */
  async startPinReset(p: Principal, ip?: string) {
    return this.auth.sendAccountCode(
      p.userId,
      'pin_reset',
      (code) => `Your ERP code to reset your withdrawal PIN is ${code}. It expires in 5 minutes. If you did not ask for this, ignore it and your PIN stays the same.`,
      ip,
    );
  }

  /** Forgot PIN, step 2: the code and a new PIN. Withdrawals then wait 24 hours. */
  async resetPin(p: Principal, b: { code: string; pin: string }) {
    // Check the new PIN first, so a weak choice does not use up the code.
    const bad = checkPin(b.pin);
    if (bad) throw new AppError(422, 'validation_failed', bad, { fields: [{ field: 'pin', message: bad }] });
    await this.db.tx(async (c) => {
      await this.auth.useAccountCode(p.userId, 'pin_reset', b.code, c);
      await c.query(`update users set pin_hash = $2, pin_failed = 0, pin_locked_until = null, pin_reset_at = now() where id = $1`, [p.userId, this.hashPin(b.pin)]);
      await this.audit.write({ actorId: p.userId, action: 'wallet.pin_reset', entity: 'user', entityId: p.userId, payload: { method: 'sms_code' } }, c);
      await notify(c, [p.userId], {
        type: 'pin_reset',
        grp: 'account',
        title: 'Withdrawal PIN reset',
        body: `Your PIN was reset. To keep your money safe, withdrawals in the next ${WITHDRAWAL_RULES.firstHoldHours} hours are sent after a wait. If this was not you, contact support now.`,
        link: '/wallet',
      });
    });
    return { set: true, message: `PIN reset. Withdrawals in the next ${WITHDRAWAL_RULES.firstHoldHours} hours wait before they are sent, to keep your money safe.` };
  }

  /** Wrong tries are counted outside any transaction so a rollback cannot erase them. */
  async verifyPin(userId: string, pin: string) {
    const u = (await this.db.query(`select pin_hash, pin_failed, pin_locked_until from users where id = $1`, [userId])).rows[0];
    if (!u.pin_hash) throw new AppError(409, 'pin_not_set', 'Set a withdrawal PIN first.');
    if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) {
      throw new AppError(423, 'pin_locked', `Too many wrong tries. Try again at ${new Date(u.pin_locked_until).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })}.`);
    }
    const [, salt, hex] = String(u.pin_hash).split('$');
    const ok = timingSafeEqual(Buffer.from(hex!, 'hex'), scryptSync(`${pin}:${this.config.otpSecret}`, salt!, 32));
    if (ok) {
      if (u.pin_failed) await this.db.query(`update users set pin_failed = 0 where id = $1`, [userId]);
      return;
    }
    const failed = u.pin_failed + 1;
    const lock = failed >= WITHDRAWAL_RULES.pinMaxTries;
    await this.db.query(`update users set pin_failed = $2, pin_locked_until = case when $3 then now() + make_interval(mins => $4) end where id = $1`, [userId, lock ? 0 : failed, lock, WITHDRAWAL_RULES.pinLockMinutes]);
    if (lock) {
      await this.audit.write({ actorId: userId, action: 'wallet.pin_locked', entity: 'user', entityId: userId });
      throw new AppError(423, 'pin_locked', `Too many wrong tries. Your PIN is locked for ${WITHDRAWAL_RULES.pinLockMinutes} minutes.`);
    }
    const left = WITHDRAWAL_RULES.pinMaxTries - failed;
    throw new AppError(422, 'pin_wrong', `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { fields: [{ field: 'pin', message: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` }] });
  }

  // ---------------------------------------------------------------- bank account

  async bankAccount(p: Principal) {
    const b = (await this.db.query(`select * from bank_accounts where owner_type = 'user' and owner_id = $1 and removed_at is null`, [p.userId])).rows[0];
    return b ? { bankCode: b.bank_code, bankName: b.bank_name, lastFour: b.last_four, accountName: b.resolved_name ?? b.account_name, nameMatches: b.name_match, firstPaid: !!b.first_paid_at, addedAt: b.created_at } : null;
  }

  /** Look the account up before saving, so the person sees the bank's name for it. */
  async resolve(p: Principal, bankCode: string, accountNumber: string) {
    const verified = await this.verified(p.userId);
    if (!isNuban(accountNumber)) throw new AppError(422, 'validation_failed', 'Enter the 10-digit account number.', { fields: [{ field: 'accountNumber', message: 'Enter the 10-digit account number.' }] });
    const r = await this.payments.resolveAccount(bankCode, accountNumber, this.config.devTools ? verified : undefined);
    if (!r) throw new AppError(422, 'account_not_found', 'We could not find that account. Check the number and the bank.', { fields: [{ field: 'accountNumber', message: 'We could not find that account.' }] });
    return { accountName: r.accountName, verifiedName: verified, matches: namesMatch(r.accountName, verified) };
  }

  async setBankAccount(p: Principal, b: { bankCode: string; accountNumber: string; pin?: string }) {
    const verified = await this.verified(p.userId);
    const hasPin = (await this.db.query(`select pin_hash is not null as set from users where id = $1`, [p.userId])).rows[0].set;
    if (hasPin) {
      if (!b.pin) throw new AppError(422, 'validation_failed', 'Enter your PIN to change your bank account.', { fields: [{ field: 'pin', message: 'Enter your PIN.' }] });
      await this.verifyPin(p.userId, b.pin);
    }
    const busy = await this.db.query(`select 1 from withdrawals where user_id = $1 and state in ('requested', 'held_first', 'processing', 'sent')`, [p.userId]);
    if (busy.rowCount) throw new AppError(409, 'withdrawal_in_progress', 'Wait for your withdrawal to finish before changing your bank account.');
    const r = await this.resolve(p, b.bankCode, b.accountNumber);
    if (!r.matches) {
      await this.audit.write({ actorId: p.userId, action: 'wallet.bank_name_mismatch', entity: 'user', entityId: p.userId, payload: { bankCode: b.bankCode, lastFour: b.accountNumber.slice(-4) } });
      throw new AppError(422, 'name_mismatch', 'This account name does not match your verified name.', { fields: [{ field: 'accountNumber', message: 'This account name does not match your verified name.' }] });
    }
    const { recipientCode } = await this.payments.createRecipient({ name: verified, accountNumber: b.accountNumber, bankCode: b.bankCode });
    await this.db.tx(async (c) => {
      const old = await c.query(`update bank_accounts set removed_at = now() where owner_type = 'user' and owner_id = $1 and removed_at is null returning id`, [p.userId]);
      await c.query(
        `insert into bank_accounts (owner_type, owner_id, bank_code, bank_name, bank_code_name, last_four, account_name, resolved_name, name_match, recipient_code, verified_at)
         values ('user', $1, $2, $3, $3, $4, $5, $6, true, $7, now())`,
        [p.userId, b.bankCode, bankName(b.bankCode), b.accountNumber.slice(-4), verified, r.accountName, recipientCode],
      );
      await this.audit.write({ actorId: p.userId, action: old.rowCount ? 'wallet.bank_changed' : 'wallet.bank_added', entity: 'user', entityId: p.userId, payload: { bankCode: b.bankCode, lastFour: b.accountNumber.slice(-4) } }, c);
      // A security notice: if someone else changed it, the owner finds out at once.
      if (old.rowCount) {
        await notify(c, [p.userId], { type: 'bank_changed', grp: 'account', title: 'Bank account changed', body: `Withdrawals now go to ${bankName(b.bankCode)}, ending ${b.accountNumber.slice(-4)}. If this was not you, contact support now.`, link: '/wallet' });
      }
    });
    return { ...(await this.bankAccount(p)), message: `${bankName(b.bankCode)}, ending ${b.accountNumber.slice(-4)} saved.` };
  }

  // ---------------------------------------------------------------- withdrawing

  private async figures(c: Queryable, userId: string) {
    const w = (
      await c.query(
        `select w.id, coalesce(b.available_kobo, 0)::bigint as available from wallets w left join wallet_balances b on b.wallet_id = w.id where w.owner_type = 'user' and w.owner_id = $1`,
        [userId],
      )
    ).rows[0];
    const today = (
      await c.query(
        `select coalesce(sum(amount_kobo), 0)::bigint as k from withdrawals where user_id = $1 and state <> 'failed_refunded'
          and created_at >= date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`,
        [userId],
      )
    ).rows[0].k;
    const bank = (await c.query(`select * from bank_accounts where owner_type = 'user' and owner_id = $1 and removed_at is null`, [userId])).rows[0];
    return { walletId: w?.id as string | undefined, available: Number(w?.available ?? 0), today: Number(today), bank };
  }

  /**
   * Why and until when a withdrawal must wait: the first one to an account, or any within
   * 24 hours of a PIN reset (a stolen SIM must not be enough to empty a wallet).
   */
  private hold(bank: { first_paid_at: Date | null }, pinResetAt: Date | null): { until: Date; reason: 'first_to_account' | 'pin_reset' } | null {
    const h = WITHDRAWAL_RULES.firstHoldHours * 3600_000;
    const afterReset = pinResetAt && Date.now() - +new Date(pinResetAt) < h ? new Date(+new Date(pinResetAt) + h) : null;
    const first = !bank.first_paid_at ? new Date(Date.now() + h) : null;
    if (afterReset && (!first || afterReset >= first)) return { until: afterReset, reason: 'pin_reset' };
    if (first) return { until: first, reason: 'first_to_account' };
    return null;
  }

  private async pinResetAt(userId: string, c: Queryable = this.db.pool): Promise<Date | null> {
    return (await c.query(`select pin_reset_at from users where id = $1`, [userId])).rows[0]?.pin_reset_at ?? null;
  }

  /** Everything the confirm sheet says: "Withdraw [Amount] to [Bank] ending [0000]? It arrives within [n] hours." */
  async quote(p: Principal, amountKobo: number) {
    await this.verified(p.userId);
    const f = await this.figures(this.db.pool, p.userId);
    const check = checkWithdrawal({ amount: kobo(amountKobo), available: kobo(f.available), withdrawnToday: kobo(f.today), limits: WALLET_LIMITS, bank: f.bank ? { nameMatches: f.bank.name_match } : undefined });
    if (!check.ok) throw new AppError(422, 'validation_failed', check.message, { fields: [{ field: check.field, message: check.message }] });
    const fee = transferFee(amountKobo);
    const hold = this.hold(f.bank, await this.pinResetAt(p.userId));
    const held = !!hold;
    const wait = !hold
      ? `It arrives within ${WITHDRAWAL_RULES.arrivesWithinHours} hours.`
      : hold.reason === 'pin_reset'
        ? `Your PIN was reset recently, so it is sent on ${when(hold.until)}, then arrives within ${WITHDRAWAL_RULES.arrivesWithinHours} hours.`
        : `Your first withdrawal to this account is sent after ${WITHDRAWAL_RULES.firstHoldHours} hours, then arrives within ${WITHDRAWAL_RULES.arrivesWithinHours} hours.`;
    return {
      amountKobo,
      feeKobo: fee,
      netKobo: amountKobo - fee,
      bank: { name: f.bank.bank_name as string, lastFour: f.bank.last_four as string },
      heldFirst: held,
      holdReason: hold?.reason ?? null,
      confirm: `Withdraw ${formatNaira(amountKobo)} to ${f.bank.bank_name}, ending ${f.bank.last_four}? ${wait}`,
      availableKobo: f.available,
      leftTodayKobo: Math.max(0, WALLET_LIMITS.dailyWithdrawLimit - f.today),
    };
  }

  async create(p: Principal, b: { amountKobo: number; pin: string; idempotencyKey: string }) {
    const prior = (await this.db.query(`select id, user_id, state from withdrawals where idempotency_key = $1`, [b.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.user_id !== p.userId) throw new AppError(409, 'idempotency_conflict', 'Try again.');
      return { id: prior.id, state: prior.state, replayed: true };
    }
    await this.verified(p.userId);
    await this.verifyPin(p.userId, b.pin);
    const out = await this.db.tx(async (c) => {
      // One withdrawal at a time per wallet: lock it, then check against the ledger.
      await c.query(`select id from wallets where owner_type = 'user' and owner_id = $1 for update`, [p.userId]);
      const f = await this.figures(c, p.userId);
      const check = checkWithdrawal({ amount: kobo(b.amountKobo), available: kobo(f.available), withdrawnToday: kobo(f.today), limits: WALLET_LIMITS, bank: f.bank ? { nameMatches: f.bank.name_match } : undefined });
      if (!check.ok) throw new AppError(422, 'validation_failed', check.message, { fields: [{ field: check.field, message: check.message }] });
      const fee = transferFee(b.amountKobo);
      const hold = this.hold(f.bank, await this.pinResetAt(p.userId, c));
      const held = !!hold;
      const id = randomUUID();
      const r = applyEvent(withdrawalMachine, 'requested', held ? 'hold_first' : 'submit', 'system');
      if (!r.ok) throw new AppError(409, r.code, 'Could not start the withdrawal.');
      await c.query(
        `insert into withdrawals (id, wallet_id, bank_account_id, amount_kobo, fee_kobo, state, idempotency_key, user_id, release_at, held_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, f.walletId, f.bank.id, b.amountKobo, fee, r.to, b.idempotencyKey, p.userId, hold?.until ?? null, hold?.reason ?? null],
      );
      // The money leaves the available balance now; a failure puts it back.
      const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
      const journal = randomUUID();
      await c.query(
        `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'withdrawal', -$3::bigint, $4, $5, $6), ($2, 'withdrawal', $3, $4, $5, $6)`,
        [f.walletId, platform, b.amountKobo, ref(id), journal, `Withdrawal to ${f.bank.bank_name}, ending ${f.bank.last_four}`],
      );
      const release = hold?.until ?? null;
      await notify(c, [p.userId], {
        type: held ? 'withdrawal_held' : 'withdrawal_started',
        grp: 'money',
        title: held ? 'Withdrawal scheduled' : 'Withdrawal on its way',
        body: held
          ? `${formatNaira(b.amountKobo)} will be sent to ${f.bank.bank_name} on ${when(release!)}. ${hold!.reason === 'pin_reset' ? 'Withdrawals wait 24 hours after a PIN reset' : `First withdrawals to an account wait ${WITHDRAWAL_RULES.firstHoldHours} hours`} to keep your money safe.`
          : `${formatNaira(b.amountKobo)} is on its way to ${f.bank.bank_name}.`,
        link: '/wallet',
      });
      await this.audit.write({ actorId: p.userId, action: 'wallet.withdraw', entity: 'withdrawal', entityId: id, payload: { amountKobo: b.amountKobo, feeKobo: fee, state: r.to } }, c);
      return { id, state: r.to as string, releaseAt: release };
    });
    if (out.state === 'processing') out.state = await this.send(out.id);
    return {
      ...out,
      message: out.state === 'held_first' ? `Scheduled. It is sent on ${when(out.releaseAt!)}.` : out.state === 'failed_refunded' ? 'Your withdrawal failed and the money is back in your wallet.' : 'On its way.',
    };
  }

  /** Queues the Paystack transfer of the amount minus the fee. A failure here refunds at once. */
  private async send(id: string): Promise<string> {
    const w = (await this.db.query(`select w.*, b.recipient_code from withdrawals w join bank_accounts b on b.id = w.bank_account_id where w.id = $1`, [id])).rows[0];
    if (!w || w.state !== 'processing') return w?.state ?? 'missing';
    try {
      const { transferCode } = await this.payments.transfer({ reference: ref(id), amountKobo: Number(w.amount_kobo) - Number(w.fee_kobo), recipientCode: w.recipient_code, reason: 'Wallet withdrawal' });
      await this.db.query(`update withdrawals set transfer_code = $2, submitted_at = now() where id = $1`, [id, transferCode]);
      return 'processing';
    } catch (e) {
      this.log.error(`withdrawal ${id} transfer could not start: ${String(e)}`);
      await this.db.tx((c) => this.fail(c, id, 'The transfer could not be started.'));
      return 'failed_refunded';
    }
  }

  private async fail(c: Queryable, id: string, reason: string) {
    const w = (await c.query(`select * from withdrawals where id = $1 for update`, [id])).rows[0];
    const r = applyEvent(withdrawalMachine, w.state, 'transfer_failed', 'system');
    if (!r.ok) return;
    await c.query(`update withdrawals set state = $2, failure_reason = $3, failed_at = now() where id = $1`, [id, r.to, reason]);
    const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
    const journal = randomUUID();
    await c.query(
      `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'withdrawal_reversal', $3, $4, $5, 'Withdrawal failed, money returned'), ($2, 'withdrawal_reversal', -$3::bigint, $4, $5, 'Withdrawal failed, money returned')`,
      [w.wallet_id, platform, w.amount_kobo, ref(id), journal],
    );
    await notify(c, [w.user_id], { type: 'withdrawal_failed', grp: 'money', title: 'Withdrawal failed', body: 'Your withdrawal failed and the money is back in your wallet.', link: '/wallet' });
    await this.audit.write({ actorId: null, actorRole: 'system', action: 'wallet.withdraw_failed', entity: 'withdrawal', entityId: id, payload: { reason } }, c);
  }

  /** Signed transfer.* webhook for references "wd:…", inside the webhook transaction. */
  async onTransfer(c: Queryable, ev: TransferEvent) {
    const id = ev.data.reference.slice('wd:'.length);
    const w = (await c.query(`select w.*, b.bank_name from withdrawals w join bank_accounts b on b.id = w.bank_account_id where w.id = $1 for update of w`, [id])).rows[0];
    if (!w) return this.log.warn(`transfer webhook for unknown withdrawal ${id}`);
    if (ev.event === 'transfer.success') {
      if (w.state !== 'processing') return;
      // Paystack's success means the receiving bank accepted it: sent, then arrived.
      await c.query(`update withdrawals set state = 'arrived', arrived_at = now() where id = $1`, [id]);
      await c.query(`update bank_accounts set first_paid_at = coalesce(first_paid_at, now()) where id = $1`, [w.bank_account_id]);
      await notify(c, [w.user_id], { type: 'withdrawal_done', grp: 'money', title: 'Withdrawal arrived', body: `${formatNaira(Number(w.amount_kobo) - Number(w.fee_kobo))} reached ${w.bank_name}.`, link: '/wallet' });
      await this.audit.write({ actorId: null, actorRole: 'system', action: 'wallet.withdraw_arrived', entity: 'withdrawal', entityId: id }, c);
    } else {
      await this.fail(c, id, ev.data.reason || 'The bank did not accept the transfer.');
    }
  }

  /** Scheduled job: first withdrawals whose hold has ended are sent. */
  async releaseHeld(): Promise<number> {
    const due = (await this.db.query(`select id from withdrawals where state = 'held_first' and release_at <= now() order by release_at limit 100`)).rows;
    for (const d of due) {
      const moved = await this.db.query(`update withdrawals set state = 'processing' where id = $1 and state = 'held_first' returning user_id`, [d.id]);
      if (!moved.rowCount) continue;
      await this.send(d.id);
    }
    return due.length;
  }

  async list(p: Principal) {
    const r = await this.db.query(
      `select w.id, w.amount_kobo, w.fee_kobo, w.state, w.release_at, w.created_at, w.arrived_at, w.failure_reason, b.bank_name, b.last_four
         from withdrawals w join bank_accounts b on b.id = w.bank_account_id where w.user_id = $1 order by w.created_at desc limit 50`,
      [p.userId],
    );
    const LINE: Record<string, string> = {
      requested: 'Starting',
      held_first: 'Scheduled',
      processing: 'On its way',
      sent: 'On its way',
      arrived: 'Arrived',
      failed_refunded: 'Failed, money returned',
    };
    return r.rows.map((x) => ({
      id: x.id,
      amountKobo: Number(x.amount_kobo),
      feeKobo: Number(x.fee_kobo),
      netKobo: Number(x.amount_kobo) - Number(x.fee_kobo),
      state: x.state,
      line: x.state === 'held_first' ? `Sent on ${when(new Date(x.release_at))}` : LINE[x.state] ?? x.state,
      bank: `${x.bank_name}, ending ${x.last_four}`,
      createdAt: x.created_at,
      arrivedAt: x.arrived_at,
    }));
  }
}
