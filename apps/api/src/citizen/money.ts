// Money helpers shared by donations and fines (B9): pay from the wallet with the PIN, or by Paystack.
import { formatNaira } from '@erp/domain';
import { randomInt, randomUUID } from 'node:crypto';
import { newReference, type PayMethod, type PaymentsAdapter } from '../adapters/payments';
import type { Db, Queryable } from '../core/db';
import { AppError } from '../core/http';

export type PayWith = 'wallet' | PayMethod;

export async function walletOf(c: Queryable, ownerType: 'user' | 'agency' | 'station' | 'platform', ownerId: string | null): Promise<string> {
  if (ownerType === 'platform') return (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
  const r = await c.query(
    `insert into wallets (owner_type, owner_id) values ($1, $2)
     on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`,
    [ownerType, ownerId],
  );
  return r.rows[0].id;
}

/** A receipt number people can read out, e.g. R-482913. */
export async function receiptNo(c: Queryable): Promise<string> {
  for (;;) {
    const no = `R-${randomInt(100000, 1000000)}`;
    if (!(await c.query(`select 1 from payments where receipt_no = $1`, [no])).rowCount) return no;
  }
}

/** The wallet balance a person can spend right now (held money is not spendable). */
export async function spendable(c: Queryable, userId: string): Promise<number> {
  const w = await walletOf(c, 'user', userId);
  return Number((await c.query(`select available_kobo from wallet_balances where wallet_id = $1`, [w])).rows[0]?.available_kobo ?? 0);
}

/**
 * Takes a wallet payment in one transaction: a succeeded payment row with a receipt, and the
 * debit from the person's wallet. The caller adds the credit legs in the same transaction.
 */
export async function payFromWallet(
  c: Queryable,
  b: { userId: string; purpose: 'donation' | 'fine' | 'install' | 'subscription'; purposeRef: string; amountKobo: number; key: string; ledgerType: 'donation_out' | 'fine' | 'payment'; memo: string },
): Promise<{ paymentId: string; reference: string; journal: string; receiptNo: string }> {
  const have = await spendable(c, b.userId);
  if (have < b.amountKobo) {
    throw new AppError(422, 'insufficient_funds', `Your wallet has ${formatNaira(have)}. Top up ${formatNaira(b.amountKobo - have)} or pay by card.`, { shortfallKobo: b.amountKobo - have });
  }
  const reference = newReference('wal');
  const no = await receiptNo(c);
  const pay = await c.query(
    `insert into payments (user_id, purpose, purpose_ref, amount_kobo, method, provider_ref, idempotency_key, state, paid_at, receipt_no)
     values ($1, $2, $3, $4, 'wallet', $5, $6, 'succeeded', now(), $7) returning id`,
    [b.userId, b.purpose, b.purposeRef, b.amountKobo, reference, b.key, no],
  );
  const journal = randomUUID();
  await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, $2, $3, $4, $5, $6)`, [
    await walletOf(c, 'user', b.userId),
    b.ledgerType,
    -b.amountKobo,
    reference,
    journal,
    b.memo,
  ]);
  return { paymentId: pay.rows[0].id, reference, journal, receiptNo: no };
}

/** Starts a Paystack charge for a purpose; the webhook finishes it (WalletService.handleWebhook). */
export async function startCharge(
  db: Db,
  payments: PaymentsAdapter,
  b: { userId: string; purpose: 'donation' | 'fine' | 'install' | 'subscription'; purposeRef: string; amountKobo: number; method: PayMethod; key: string },
) {
  const user = (await db.query(`select email, phone from users where id = $1`, [b.userId])).rows[0];
  const reference = newReference({ fine: 'fine', donation: 'don', install: 'inst', subscription: 'sub' }[b.purpose]);
  await db.query(
    `insert into payments (user_id, purpose, purpose_ref, amount_kobo, method, provider_ref, idempotency_key, state) values ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [b.userId, b.purpose, b.purposeRef, b.amountKobo, b.method, reference, b.key],
  );
  const init = await payments.initialize({
    reference,
    amountKobo: b.amountKobo,
    method: b.method,
    email: user.email ?? `${String(user.phone).replace('+', '')}@sms.erp.local`,
    metadata: { purpose: b.purpose, userId: b.userId },
  });
  return { ...init, state: 'pending' as const };
}

/** Replays a request that used the same idempotency key (double tap): same answer, no second charge. */
export async function replayed(c: Queryable, key: string, userId: string) {
  const r = (await c.query(`select user_id, provider_ref, state, method, receipt_no from payments where idempotency_key = $1`, [key])).rows[0];
  if (!r) return null;
  if (r.user_id !== userId) throw new AppError(409, 'idempotency_conflict', 'Try again.');
  return { reference: r.provider_ref as string, state: r.state as string, method: r.method as string, receiptNo: r.receipt_no as string | null, replayed: true };
}
