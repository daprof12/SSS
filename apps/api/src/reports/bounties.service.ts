// Agency side of bounties (board "Agency bounties"): the pool the agency funds in
// advance, its rates per tip category, and what it has paid.
import { agencyHandles, BOUNTY_VERIFIED_WHEN, formatNaira, POOL_FUND_LIMITS, tipCategory } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { newReference, PAYMENTS, type PaymentsAdapter, type PayMethod } from '../adapters/payments';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { agencyStaff, notify } from './shared';

export interface RateInput {
  basis: 'fixed' | 'tiered';
  standardKobo: number;
  seriousKobo?: number;
  capKobo?: number | null;
  active: boolean;
}

/** The pool wallet, created on first use. */
export async function poolWallet(c: Queryable, agencyId: string): Promise<string> {
  return (
    await c.query(
      `insert into wallets (owner_type, owner_id) values ('bounty_pool', $1) on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`,
      [agencyId],
    )
  ).rows[0].id;
}

@Injectable()
export class BountiesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
  ) {}

  private async kind(agencyId: string): Promise<string> {
    return (await this.db.query(`select kind from agencies where id = $1`, [agencyId])).rows[0]?.kind ?? '';
  }

  async summary(p: Principal, agencyId: string) {
    await this.agencies.requireStaff(p, agencyId);
    await this.agencies.requireHandles(agencyId, 'bounties');
    const wallet = await poolWallet(this.db.pool, agencyId);
    const [bal, claims, paid, tips, rates, moves, pending] = await Promise.all([
      this.db.query(`select coalesce(available_kobo, 0)::bigint as available from wallet_balances where wallet_id = $1`, [wallet]),
      this.db.query(
        `select count(*)::int as n, coalesce(sum(c.suggested_kobo), 0)::bigint as kobo from tips t join tip_claims c on c.tip_id = t.id where t.agency_id = $1 and t.state = 'claim_review'`,
        [agencyId],
      ),
      this.db.query(
        `select coalesce(-sum(amount_kobo), 0)::bigint as kobo, count(*)::int as n from wallet_ledger
          where wallet_id = $1 and type = 'bounty' and amount_kobo < 0 and created_at >= date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`,
        [wallet],
      ),
      this.db.query(`select count(*)::int as n from tips where agency_id = $1 and created_at >= date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`, [agencyId]),
      this.db.query(`select category, basis, tiers, cap_kobo, active from bounty_rates where agency_id = $1`, [agencyId]),
      this.db.query(
        `select l.type, l.amount_kobo, l.reference, l.memo, l.created_at, t.public_no
           from wallet_ledger l left join tips t on l.reference = 'tip:' || t.id::text
          where l.wallet_id = $1 order by l.created_at desc, l.id desc limit 20`,
        [wallet],
      ),
      this.db.query(`select provider_ref, amount_kobo, method, created_at from payments where agency_id = $1 and purpose = 'bounty_pool' and state in ('initiated', 'pending') order by created_at desc limit 5`, [agencyId]),
    ]);
    const available = Number(bal.rows[0]?.available ?? 0);
    const pendingClaims = Number(claims.rows[0].kobo);
    const byCat = new Map(rates.rows.map((r) => [r.category, r]));
    const handles = agencyHandles(await this.kind(agencyId));
    return {
      pool: {
        availableKobo: available,
        pendingClaimsKobo: pendingClaims,
        // States doc: "Pool has [Amount], below pending claims of [Amount]."
        low: available < pendingClaims ? `Pool has ${formatNaira(available)}, below pending claims of ${formatNaira(pendingClaims)}.` : available === 0 ? 'Your pool is empty. Add funds so you can approve bounties.' : null,
      },
      claimsWaiting: claims.rows[0].n,
      paidThisMonth: { kobo: Number(paid.rows[0].kobo), tips: paid.rows[0].n },
      tipsThisMonth: tips.rows[0].n,
      limits: POOL_FUND_LIMITS,
      rates: handles.bountyCategories.map((code) => {
        const r = byCat.get(code);
        const min = r?.tiers?.min == null ? null : Number(r.tiers.min);
        const max = r?.tiers?.max == null ? min : Number(r.tiers.max);
        return {
          category: code,
          label: tipCategory(code)?.label ?? code,
          verifiedWhen: BOUNTY_VERIFIED_WHEN[code] ?? 'Result recorded by the agency',
          set: !!r,
          active: r?.active ?? false,
          basis: (r?.basis ?? 'tiered') as 'fixed' | 'tiered' | 'percent_capped',
          standardKobo: min,
          seriousKobo: max,
          capKobo: r?.cap_kobo == null ? null : Number(r.cap_kobo),
        };
      }),
      history: moves.rows.map((m) => ({
        kind: m.type === 'bounty' ? (Number(m.amount_kobo) < 0 ? 'paid' : 'returned') : m.type,
        amountKobo: Number(m.amount_kobo),
        label: m.type === 'fund' ? (m.memo ?? 'Pool funded') : m.type === 'bounty' ? `Bounty for tip ${m.public_no ?? ''}`.trim() : (m.memo ?? m.type),
        at: m.created_at,
      })),
      pendingFunding: pending.rows.map((x) => ({ reference: x.provider_ref, amountKobo: Number(x.amount_kobo), method: x.method, since: x.created_at })),
    };
  }

  /** Board "Add or change a rate". Only categories this agency receives and that pay bounties. */
  async setRate(p: Principal, agencyId: string, category: string, b: RateInput) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    await this.agencies.requireHandles(agencyId, 'bounties');
    if (!agencyHandles(await this.kind(agencyId)).bountyCategories.includes(category)) throw new AppError(422, 'validation_failed', 'Your agency does not pay bounties for this category.');
    const serious = b.basis === 'tiered' ? (b.seriousKobo ?? 0) : b.standardKobo;
    const fields: { field: string; message: string }[] = [];
    if (b.basis === 'tiered' && serious < b.standardKobo) fields.push({ field: 'seriousKobo', message: 'A serious result should pay at least the standard amount.' });
    if (b.capKobo != null && b.capKobo < serious) fields.push({ field: 'capKobo', message: 'The cap must be at least the highest bounty.' });
    if (fields.length) throw new AppError(422, 'validation_failed', fields[0]!.message, { fields });
    const prior = (await this.db.query(`select basis, tiers, cap_kobo, active from bounty_rates where agency_id = $1 and category = $2`, [agencyId, category])).rows[0] ?? null;
    await this.db.tx(async (c) => {
      await c.query(
        `insert into bounty_rates (agency_id, category, basis, tiers, cap_kobo, active) values ($1, $2, $3, $4, $5, $6)
         on conflict (agency_id, category) do update set basis = excluded.basis, tiers = excluded.tiers, cap_kobo = excluded.cap_kobo, active = excluded.active`,
        [agencyId, category, b.basis, { min: b.standardKobo, max: serious }, b.capKobo ?? null, b.active],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'bounty.rate_set', entity: 'agency', entityId: agencyId, payload: { category, before: prior, after: b } }, c);
    });
    return { ok: true, message: b.active ? `Rate saved for ${tipCategory(category)?.label ?? category}.` : 'Rate saved and paused. This category pays no bounty until you turn it on.' };
  }

  /** Fund the pool through Paystack. The pool is credited only on the signed webhook. */
  async fund(p: Principal, agencyId: string, b: { amountKobo: number; method: PayMethod; idempotencyKey: string }) {
    await this.agencies.requireStaff(p, agencyId);
    await this.agencies.requireHandles(agencyId, 'bounties');
    const prior = (await this.db.query(`select agency_id, provider_ref, state from payments where idempotency_key = $1`, [b.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.agency_id !== agencyId) throw new AppError(409, 'idempotency_conflict', 'Try again.');
      return { reference: prior.provider_ref, state: prior.state, replayed: true };
    }
    const { minKobo, maxKobo } = POOL_FUND_LIMITS;
    if (b.amountKobo < minKobo || b.amountKobo > maxKobo) {
      const message = `Enter between ${formatNaira(minKobo)} and ${formatNaira(maxKobo)}.`;
      throw new AppError(422, 'validation_failed', message, { fields: [{ field: 'amount', message }] });
    }
    const email = (await this.db.query(`select official_email from agencies where id = $1`, [agencyId])).rows[0]?.official_email;
    const reference = newReference('pool');
    await this.db.tx(async (c) => {
      await c.query(
        `insert into payments (user_id, agency_id, purpose, amount_kobo, method, provider_ref, idempotency_key, state) values ($1, $2, 'bounty_pool', $3, $4, $5, $6, 'pending')`,
        [p.userId, agencyId, b.amountKobo, b.method, reference, b.idempotencyKey],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'bounty_pool.fund_started', entity: 'agency', entityId: agencyId, payload: { reference, amountKobo: b.amountKobo, method: b.method } }, c);
    });
    const init = await this.payments.initialize({ reference, amountKobo: b.amountKobo, method: b.method, email: email ?? 'billing@agency.erp.local', metadata: { purpose: 'bounty_pool', agencyId } });
    return { ...init, state: 'pending' as const, amount: formatNaira(b.amountKobo), message: 'Confirming your payment.' };
  }

  async fundStatus(p: Principal, agencyId: string, reference: string) {
    await this.agencies.requireStaff(p, agencyId);
    const x = (await this.db.query(`select provider_ref, state, amount_kobo, failure_reason from payments where provider_ref = $1 and agency_id = $2 and purpose = 'bounty_pool'`, [reference, agencyId])).rows[0];
    if (!x) throw new AppError(404, 'not_found', 'Payment not found.');
    const message: Record<string, string> = {
      pending: 'Confirming your payment.',
      initiated: 'Confirming your payment.',
      succeeded: `${formatNaira(x.amount_kobo)} was added to your bounty pool.`,
      failed: 'Your card was not charged. Try again or use another card.',
      abandoned: 'Payment not finished.',
    };
    return { reference: x.provider_ref, state: x.state, amountKobo: Number(x.amount_kobo), reason: x.failure_reason, message: message[x.state] ?? '' };
  }
}

/** Called by the Paystack webhook inside its transaction. External money in: pool +, platform clearing −. */
export async function creditPool(c: Queryable, pay: { agency_id: string; provider_ref: string }, amountKobo: number, journalId: string, how: string) {
  const pool = await poolWallet(c, pay.agency_id);
  const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
  await c.query(
    `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'fund', $3, $4, $5, $6), ($2, 'fund', -$3::bigint, $4, $5, $6)`,
    [pool, platform, amountKobo, pay.provider_ref, journalId, `Pool funded by ${how}`],
  );
  await notify(c, await agencyStaff(c, pay.agency_id), { type: 'pool_funded', grp: 'money', title: 'Bounty pool funded', body: `${formatNaira(amountKobo)} was added to your bounty pool.`, link: '/agency/bounties' });
}

export async function poolFundFailed(c: Queryable, pay: { agency_id: string }) {
  await notify(c, await agencyStaff(c, pay.agency_id), { type: 'pool_fund_failed', grp: 'money', title: 'Pool funding failed', body: 'Your card was not charged. Try again or use another card.', link: '/agency/bounties' });
}
