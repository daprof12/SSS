// Rewards for rated responses (PRD "Ratings and rewards"; SRS TRUST-5 and TRUST-6).
// On an incident's first rating, the platform rewards pool pays the officers who responded,
// by the agency's rule, held REWARD_RULES.holdDays before it can be withdrawn.
import { checkRewardRule, DEFAULT_REWARD_RULE, DONATION_RULES, donationFee, formatNaira, REWARD_RULES, rewardFor, splitReward, type RewardRule } from '@erp/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import { requirePerm, type Principal } from '../core/auth';
import { dateWhere, type DateRange } from '../core/date-range';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';

const SKIP: Record<string, string> = {
  low_rating: 'Rated 3 stars or fewer',
  no_rule: 'No reward rule set',
  pool_empty: 'Rewards pool too low',
  reporter_is_staff: 'Rated by agency staff',
  repeat_rater: 'Same person rated this station too often',
  daily_cap: 'Daily cap reached',
};

@Injectable()
export class RewardsService {
  private readonly log = new Logger('Rewards');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
  ) {}

  private async rule(c: Queryable, agencyId: string): Promise<(RewardRule & { active: boolean }) | null> {
    const r = (await c.query(`select * from reward_rules where agency_id = $1`, [agencyId])).rows[0];
    return r ? { fiveStarKobo: Number(r.five_star_kobo), fourStarPct: r.four_star_pct, split: r.split, active: r.active } : null;
  }

  /**
   * Decides and pays the reward for a just-rated incident. Never throws to the caller:
   * a reward problem must not fail the citizen's rating.
   */
  async payForRating(incidentId: string, reporterId: string, stars: number): Promise<{ state: string; reason?: string; totalKobo?: number }> {
    try {
      return await this.db.tx(async (c) => {
        // One decision per incident: the first rating. Joiners' ratings do not pay again.
        const done = (await c.query(`select state, reason, total_kobo from reward_payments where incident_id = $1`, [incidentId])).rows[0];
        if (done) return { state: 'already' };
        const i = (await c.query(`select id, agency_id, station_id, type, state from incidents where id = $1 for update`, [incidentId])).rows[0];
        if (!i || i.state !== 'resolved') return { state: 'not_resolved' };
        const team = (
          await c.query(
            `select distinct on (officer_id) officer_id, role, accepted_at, station_id from incident_units where incident_id = $1 and accepted_at is not null and officer_id is not null order by officer_id, accepted_at`,
            [incidentId],
          )
        ).rows.sort((a, b) => +new Date(a.accepted_at) - +new Date(b.accepted_at));

        const skip = async (reason: string) => {
          await c.query(`insert into reward_payments (incident_id, agency_id, stars, state, reason) values ($1, $2, $3, 'skipped', $4)`, [incidentId, i.agency_id, stars, reason]);
          return { state: 'skipped', reason };
        };
        if (!team.length || !i.agency_id) return skip('no_rule');
        const rule = await this.rule(c, i.agency_id);
        if (!rule || !rule.active) return skip('no_rule');
        const amount = rewardFor(stars, rule);
        if (amount <= 0) return skip('low_rating');

        // Anti-gaming (TRUST-6): staff rating their own agency, and rating rings.
        const staff = await c.query(
          `select 1 from user_roles ur left join stations s on ur.scope_type = 'station' and s.id = ur.scope_id
            where ur.user_id = $1 and ((ur.scope_type = 'agency' and ur.scope_id = $2) or s.agency_id = $2) limit 1`,
          [reporterId, i.agency_id],
        );
        if (staff.rowCount || team.some((t) => t.officer_id === reporterId)) return skip('reporter_is_staff');
        const repeats = (
          await c.query(
            `select count(*)::int as n from ratings r
              where r.reporter_id = $1 and r.incident_id <> $3 and r.created_at > now() - interval '30 days'
                and exists (select 1 from incident_units u where u.incident_id = r.incident_id and u.station_id = $2 and u.accepted_at is not null)`,
            [reporterId, (team.find((t) => t.role === 'primary') ?? team[0]).station_id, incidentId],
          )
        ).rows[0].n;
        if (repeats >= REWARD_RULES.repeatRaterLimit) return skip('repeat_rater');

        // Split, then trim to each officer's daily cap.
        let shares = splitReward(amount, team.map((t, k) => ({ id: t.officer_id, lead: t.role === 'primary' || (k === 0 && !team.some((x) => x.role === 'primary')) })), rule.split);
        const today = (
          await c.query(
            `select w.owner_id, coalesce(sum(l.amount_kobo), 0)::bigint as k from wallet_ledger l join wallets w on w.id = l.wallet_id
              where w.owner_type = 'user' and w.owner_id = any($1::uuid[]) and l.type = 'reward' and l.amount_kobo > 0
                and l.created_at >= date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'
              group by w.owner_id`,
            [shares.map((s) => s.id)],
          )
        ).rows;
        const earned = new Map(today.map((r) => [r.owner_id, Number(r.k)]));
        shares = shares.map((s) => ({ ...s, kobo: Math.max(0, Math.min(s.kobo, REWARD_RULES.dailyCapPerOfficerKobo - (earned.get(s.id) ?? 0))) })).filter((s) => s.kobo > 0);
        const total = shares.reduce((a, s) => a + s.kobo, 0);
        if (!total) return skip('daily_cap');

        const pool = (await c.query(`select w.id, coalesce(b.available_kobo, 0)::bigint as k from wallets w left join wallet_balances b on b.wallet_id = w.id where w.owner_type = 'rewards_pool' and w.owner_id is null for update of w`)).rows[0];
        if (!pool || Number(pool.k) < total) return skip('pool_empty');

        const journal = randomUUID();
        const ref = `incident:${incidentId}`;
        const memo = `Reward, ${stars}-star response`;
        await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'reward', -$2::bigint, $3, $4, $5)`, [pool.id, total, ref, journal, memo]);
        for (const s of shares) {
          const wallet = (await c.query(`insert into wallets (owner_type, owner_id) values ('user', $1) on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`, [s.id])).rows[0].id;
          await c.query(
            `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo, available_at) values ($1, 'reward', $2, $3, $4, $5, now() + make_interval(days => $6))`,
            [wallet, s.kobo, ref, journal, memo, REWARD_RULES.holdDays],
          );
        }
        const availableAt = new Date(Date.now() + REWARD_RULES.holdDays * 86_400_000);
        await c.query(
          `insert into reward_payments (incident_id, agency_id, stars, total_kobo, state, shares, available_at) values ($1, $2, $3, $4, 'paid', $5, $6)`,
          [incidentId, i.agency_id, stars, total, JSON.stringify(shares), availableAt],
        );
        const day = availableAt.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short' });
        for (const s of shares) {
          // States doc: "You earned [Amount] for a [n]-star response."; pending: "[Amount] is released on [date]."
          await notify(c, [s.id], {
            type: 'reward_earned',
            grp: 'money',
            title: 'Reward earned',
            body: `You earned ${formatNaira(s.kobo)} for a ${stars}-star response. It is released on ${day}.`,
            link: `/history/${incidentId}`,
          });
        }
        await this.audit.write({ actorId: null, actorRole: 'system', action: 'reward.paid', entity: 'incident', entityId: incidentId, payload: { stars, total, shares, journal } }, c);
        return { state: 'paid', totalKobo: total };
      });
    } catch (e) {
      this.log.error(`reward for ${incidentId} failed: ${String(e)}`);
      return { state: 'error' };
    }
  }

  // ---------------------------------------------------------------- agency side

  async summary(p: Principal, agencyId: string) {
    await this.agencies.requireStaff(p, agencyId);
    const rule = (await this.rule(this.db.pool, agencyId)) ?? null;
    const month = (
      await this.db.query(
        `select coalesce(sum(total_kobo) filter (where state = 'paid'), 0)::bigint as kobo, count(*) filter (where state = 'paid')::int as paid, count(*) filter (where state = 'skipped')::int as skipped
           from reward_payments where agency_id = $1 and created_at >= date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`,
        [agencyId],
      )
    ).rows[0];
    const recent = (
      await this.db.query(
        `select r.*, t.label as type_label, l.postcode, s.name as station from reward_payments r join incidents i on i.id = r.incident_id
           join incident_types t on t.code = i.type left join locations l on l.id = i.location_id left join stations s on s.id = i.station_id
          where r.agency_id = $1 order by r.created_at desc limit 30`,
        [agencyId],
      )
    ).rows;
    const ids = [...new Set(recent.flatMap((r) => (r.shares as { id: string }[]).map((s) => s.id)))];
    const names = new Map((await this.db.query(`select id, display_name from users where id = any($1::uuid[])`, [ids])).rows.map((u) => [u.id, u.display_name]));
    const shares = (await this.db.query(`select officer_pct, station_pct, agency_pct from payout_shares where agency_id = $1`, [agencyId])).rows[0];
    return {
      rule: rule ?? { ...DEFAULT_REWARD_RULE, active: false },
      ruleSet: !!rule,
      limits: { maxFiveStarKobo: REWARD_RULES.maxFiveStarKobo, dailyCapPerOfficerKobo: REWARD_RULES.dailyCapPerOfficerKobo, holdDays: REWARD_RULES.holdDays },
      month: { kobo: Number(month.kobo), paid: month.paid, skipped: month.skipped },
      donationShares: shares ? { officerPct: Number(shares.officer_pct), stationPct: Number(shares.station_pct), agencyPct: Number(shares.agency_pct) } : null,
      recent: recent.map((r) => ({
        incidentId: r.incident_id,
        title: `${r.type_label}${r.postcode ? `, ${r.postcode}` : ''}`,
        station: r.station,
        stars: r.stars,
        state: r.state,
        reason: r.reason ? (SKIP[r.reason] ?? r.reason) : null,
        totalKobo: Number(r.total_kobo),
        officers: (r.shares as { id: string; kobo: number }[]).map((s) => ({ name: names.get(s.id) ?? 'Officer', kobo: s.kobo })),
        at: r.created_at,
      })),
    };
  }

  /** Board "Agency payouts" → "Reward for a 5-star response", and how it is split. */
  async setRule(p: Principal, agencyId: string, b: RewardRule & { active: boolean }) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    const bad = checkRewardRule(b);
    if (bad) throw new AppError(422, 'validation_failed', bad.message, { fields: [bad] });
    const before = await this.rule(this.db.pool, agencyId);
    await this.db.tx(async (c) => {
      await c.query(
        `insert into reward_rules (agency_id, five_star_kobo, four_star_pct, split, active, updated_by, updated_at) values ($1, $2, $3, $4, $5, $6, now())
         on conflict (agency_id) do update set five_star_kobo = excluded.five_star_kobo, four_star_pct = excluded.four_star_pct, split = excluded.split, active = excluded.active, updated_by = excluded.updated_by, updated_at = now()`,
        [agencyId, b.fiveStarKobo, b.fourStarPct, b.split, b.active, p.userId],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'reward.rule_set', entity: 'agency', entityId: agencyId, payload: { before, after: b } }, c);
    });
    return { message: b.active ? `Rewards on: ${formatNaira(b.fiveStarKobo)} for a 5-star response.` : 'Rewards paused for your officers.' };
  }

  /**
   * Donations to this agency: given to it, to one of its stations, or to one of its officers. Totals by
   * level for the dates chosen, and the gifts themselves. Donors who chose to stay anonymous stay so.
   */
  async donations(p: Principal, agencyId: string, q: DateRange & { level?: 'agency' | 'station' | 'officer' }) {
    requirePerm(p, 'agency.money', agencyId);
    return this.donationsFor({ agencyId }, q);
  }

  /**
   * The gifts in one scope: an agency (to it, its stations and its officers) or a station (to it and
   * its officers). Totals by level for the dates chosen, and the gifts themselves.
   */
  private async donationsFor(scope: { agencyId: string } | { stationId: string }, q: DateRange & { level?: 'agency' | 'station' | 'officer' }) {
    const args: unknown[] = ['agencyId' in scope ? scope.agencyId : scope.stationId];
    const who =
      'agencyId' in scope
        ? `(d.target_type = 'agency' and d.target_id = $1 or d.target_type = 'station' and st.agency_id = $1 or d.target_type = 'officer' and os.agency_id = $1)`
        : `(d.target_type = 'station' and d.target_id = $1 or d.target_type = 'officer' and o.station_id = $1)`;
    const where = [`d.state = 'paid'`, who, dateWhere(q, args, 'd.paid_at')].join(' and ');
    const from = `from donations d
      left join stations st on d.target_type = 'station' and st.id = d.target_id
      left join officers o on d.target_type = 'officer' and o.user_id = d.target_id
      left join stations os on os.id = o.station_id
      left join users ou on ou.id = o.user_id
      left join users du on du.id = d.donor_id`;
    const t = (
      await this.db.query(
        `select count(*)::int as n, coalesce(sum(d.amount_kobo), 0)::bigint as total,
                coalesce(sum(d.amount_kobo) filter (where d.target_type = 'agency'), 0)::bigint as agency,
                coalesce(sum(d.amount_kobo) filter (where d.target_type = 'station'), 0)::bigint as station,
                coalesce(sum(d.amount_kobo) filter (where d.target_type = 'officer'), 0)::bigint as officer,
                coalesce(sum(d.amount_kobo) filter (where d.payout_state = 'queued'), 0)::bigint as waiting
           ${from} where ${where}`,
        args,
      )
    ).rows[0];
    const la = [...args];
    const rows = (
      await this.db.query(
        `select d.id, d.amount_kobo, d.target_type, d.show_name, d.payout_state, d.paid_at, du.display_name as donor,
                case d.target_type when 'agency' then (select name from agencies where id = d.target_id) when 'station' then st.name else ou.display_name end as recipient,
                case d.target_type when 'officer' then os.name end as officer_station
           ${from} where ${where} ${q.level ? `and d.target_type = $${la.push(q.level)}` : ''}
          order by d.paid_at desc nulls last limit 100`,
        la,
      )
    ).rows;
    const net = (k: number) => k - donationFee(k);
    return {
      feePct: DONATION_RULES.platformFeePct,
      totals: {
        gifts: t.n,
        kobo: Number(t.total),
        netKobo: net(Number(t.total)),
        agencyKobo: Number(t.agency),
        stationsKobo: Number(t.station),
        officersKobo: Number(t.officer),
        waitingKobo: net(Number(t.waiting)),
      },
      items: rows.map((d) => ({
        id: d.id,
        at: d.paid_at,
        donor: d.show_name ? d.donor : 'Anonymous',
        level: d.target_type as 'agency' | 'station' | 'officer',
        recipient: d.recipient ?? '—',
        station: d.officer_station ?? null,
        amountKobo: Number(d.amount_kobo),
        netKobo: net(Number(d.amount_kobo)),
        payout: d.payout_state,
      })),
    };
  }

  // ---------------------------------------------------------------- station (read only, station head)

  private stationOf(p: Principal): string {
    const sid = p.roles.find((r) => r.role === 'head' && r.scopeType === 'station')?.scopeId;
    if (!sid) throw new AppError(403, 'forbidden', 'This is for the station head.');
    requirePerm(p, 'station.manage', sid);
    return sid;
  }

  /**
   * Station "Payouts": rewards paid to this station's officers for rated responses, for the dates
   * chosen; what each officer earned; and the agency's rule, so the head can explain it. Read only:
   * the agency sets the rule.
   */
  async stationPayouts(p: Principal, q: DateRange) {
    const sid = this.stationOf(p);
    const st = (await this.db.query(`select s.name, s.agency_id, a.name as agency from stations s join agencies a on a.id = s.agency_id where s.id = $1`, [sid])).rows[0];
    const args: unknown[] = [sid];
    const rows = (
      await this.db.query(
        `select r.*, t.label as type_label, l.postcode from reward_payments r join incidents i on i.id = r.incident_id
           join incident_types t on t.code = i.type left join locations l on l.id = i.location_id
          where i.station_id = $1 and ${dateWhere(q, args, 'r.created_at')} order by r.created_at desc limit 200`,
        args,
      )
    ).rows;
    const officers = (await this.db.query(`select o.user_id, u.display_name from officers o join users u on u.id = o.user_id where o.station_id = $1 order by u.display_name`, [sid])).rows;
    const ids = [...new Set([...officers.map((o) => o.user_id as string), ...rows.flatMap((r) => (r.shares as { id: string }[]).map((x) => x.id))])];
    const names = new Map((await this.db.query(`select id, display_name from users where id = any($1::uuid[])`, [ids])).rows.map((u) => [u.id, u.display_name]));
    const earned = new Map<string, { kobo: number; responses: number }>();
    for (const r of rows)
      if (r.state === 'paid')
        for (const x of r.shares as { id: string; kobo: number }[]) {
          const e = earned.get(x.id) ?? { kobo: 0, responses: 0 };
          earned.set(x.id, { kobo: e.kobo + x.kobo, responses: e.responses + 1 });
        }
    const rule = await this.rule(this.db.pool, st.agency_id);
    const paid = rows.filter((r) => r.state === 'paid');
    return {
      station: st.name as string,
      agency: st.agency as string,
      rule: rule ? { active: rule.active, fiveStarKobo: rule.fiveStarKobo, fourStarPct: rule.fourStarPct, split: rule.split } : null,
      holdDays: REWARD_RULES.holdDays,
      totals: { kobo: paid.reduce((a, r) => a + Number(r.total_kobo), 0), paid: paid.length, skipped: rows.length - paid.length },
      officers: officers
        .map((o) => ({ id: o.user_id as string, name: o.display_name as string, kobo: earned.get(o.user_id)?.kobo ?? 0, responses: earned.get(o.user_id)?.responses ?? 0 }))
        .sort((x, y) => y.kobo - x.kobo),
      recent: rows.slice(0, 50).map((r) => ({
        incidentId: r.incident_id,
        title: `${r.type_label}${r.postcode ? `, ${r.postcode}` : ''}`,
        stars: r.stars,
        state: r.state,
        reason: r.reason ? (SKIP[r.reason] ?? r.reason) : null,
        totalKobo: Number(r.total_kobo),
        officers: (r.shares as { id: string; kobo: number }[]).map((x) => ({ name: names.get(x.id) ?? 'Officer', kobo: x.kobo })),
        at: r.created_at,
      })),
    };
  }

  /** Station "Donations": gifts to this station and its officers. Read only. */
  async stationDonations(p: Principal, q: DateRange & { level?: 'station' | 'officer' }) {
    return this.donationsFor({ stationId: this.stationOf(p) }, q);
  }

  /** "How money is shared" for donations (used when donations launch). Must add up to 100%. */
  async setDonationShares(p: Principal, agencyId: string, b: { officerPct: number; stationPct: number; agencyPct: number }) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    if ([b.officerPct, b.stationPct, b.agencyPct].some((x) => x < 0 || x > 100) || Math.round((b.officerPct + b.stationPct + b.agencyPct) * 100) !== 10000) {
      throw new AppError(422, 'validation_failed', 'The three shares must add up to 100%.', { fields: [{ field: 'shares', message: 'The three shares must add up to 100%.' }] });
    }
    await this.db.query(
      `insert into payout_shares (agency_id, officer_pct, station_pct, agency_pct) values ($1, $2, $3, $4)
       on conflict (agency_id) do update set officer_pct = excluded.officer_pct, station_pct = excluded.station_pct, agency_pct = excluded.agency_pct`,
      [agencyId, b.officerPct, b.stationPct, b.agencyPct],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'donation.shares_set', entity: 'agency', entityId: agencyId, payload: b });
    return { message: 'Donation shares saved.' };
  }
}
