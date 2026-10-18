// Tips → bounty (Rewards doc "Whistleblower bounty"; Report Tracking B2).
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { applyEvent, availableEvents, bountyFee, bountyRangeText, formatNaira, percent, suggestBounty, type BountyRate, tipCategories, tipCategory, tipMachine, tipStatus } from '@erp/domain';
import { POSTCODE, PostcodeUnavailable, type PostcodeAdapter } from '../adapters/postcode';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { agencyFee } from './bounties.service';
import { agencyStaff, notify, publicNo, receivingAgency } from './shared';

/** Bounties wait this long before they can be withdrawn (Rewards doc "[n] days"). Placeholder. */
export const BOUNTY_HOLD_DAYS = 7;
const DAILY_TIP_LIMIT = 10;

type Actor = 'tipper' | 'agency_admin' | 'system';

@Injectable()
export class TipsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
  ) {}

  /** Categories with who receives each one now and its bounty range. */
  async categories() {
    const out = [];
    for (const c of tipCategories) {
      const agency = await receivingAgency(this.db.pool, c.agencyKinds);
      let range: { min: number; max: number; text: string } | null = null;
      if (agency && c.bounty) {
        const r = (await this.db.query(`select basis, tiers, cap_kobo from bounty_rates where agency_id = $1 and category = $2 and active`, [agency.id, c.code])).rows[0];
        if (r) {
          const rate = toRate(r);
          const top = rate.basis === 'percent_capped' ? rate.capKobo! : suggestBounty(rate, { severity: 'high' });
          range = { min: rate.basis === 'percent_capped' ? 0 : suggestBounty(rate, { severity: 'standard' }), max: top, text: bountyRangeText(rate, (k) => formatNaira(k).replace('.00', '')) };
        }
      }
      out.push({
        code: c.code,
        label: c.label,
        agencyLabel: agency?.name ?? c.agencyLabel,
        joined: !!agency,
        bounty: range,
        emergencyHint: c.emergencyHint ?? null,
        anonymousDefault: c.anonymousDefault ?? true,
      });
    }
    return out;
  }

  private async transition(c: Queryable, tipId: string, event: Parameters<typeof applyEvent>[2], actor: Actor, payload: Record<string, unknown> = {}, isPublic = true) {
    const t = (await c.query(`select state from tips where id = $1 for update`, [tipId])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Tip not found.');
    const r = applyEvent(tipMachine, t.state, event as never, actor as never);
    if (!r.ok) throw new AppError(r.code === 'actor_not_allowed' ? 403 : 409, r.code, 'That is not possible at this stage.');
    await c.query(`update tips set state = $2, updated_at = now() where id = $1`, [tipId, r.to]);
    await c.query(`insert into tip_events (tip_id, kind, actor_kind, payload, public) values ($1, $2, $3, $4, $5)`, [tipId, event, actor === 'agency_admin' ? 'agency' : actor, payload, isPublic]);
    return r.to;
  }

  async create(p: Principal, b: { category: string; description: string; postcode?: string; lat?: number; lng?: number; anonymous: boolean; clientRef: string }) {
    const cat = tipCategory(b.category);
    if (!cat) throw new AppError(422, 'validation_failed', 'Choose what you are reporting.', { fields: [{ field: 'category', message: 'Choose what you are reporting.' }] });
    const description = b.description.trim();
    if (description.length < 20) throw new AppError(422, 'validation_failed', 'Add a little more so the agency can act.', { fields: [{ field: 'description', message: 'Add a little more so the agency can act.' }] });

    const prior = (await this.db.query(`select id, public_no from tips where details->>'clientRef' = $1 and user_id = $2`, [b.clientRef, p.userId])).rows[0];
    if (prior) return { id: prior.id, publicNo: prior.public_no, duplicate: true };
    const today = (await this.db.query(`select count(*)::int as n from tips where user_id = $1 and created_at > now() - interval '1 day'`, [p.userId])).rows[0].n;
    if (today >= DAILY_TIP_LIMIT) throw new AppError(429, 'tip_limit', 'You have sent many tips today. Try again tomorrow.');

    let building = null;
    try {
      building = b.postcode ? await this.postcode.lookup(b.postcode) : b.lat != null ? await this.postcode.nearest(b.lat, b.lng!, 100) : null;
    } catch (e) {
      if (!(e instanceof PostcodeUnavailable)) throw e; // a tip never fails on the address service
    }
    if (b.postcode && !building) throw new AppError(422, 'postcode_not_found', 'We could not find that building. Check the postcode or leave it out.', { fields: [{ field: 'postcode', message: 'Check the postcode.' }] });

    return this.db.tx(async (c) => {
      const agency = await receivingAgency(c, cat.agencyKinds);
      const locationId = building
        ? (
            await c.query(
              `insert into locations (postcode, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
               values ($1, $2, $3, $4, $5, $6, $7, st_setsrid(st_makepoint($9, $8), 4326)::geography)
               on conflict (postcode) do update set fetched_at = now() returning id`,
              [building.postcode, building.address, building.stateId, building.lgaId, building.districtId, building.areaId, building.areaLabel, building.lat, building.lng],
            )
          ).rows[0].id
        : null;
      const no = await publicNo(c, 'tips', 'T');
      const tip = (
        await c.query(
          `insert into tips (user_id, category, agency_id, agency_label, location_id, description, anonymous, public_no, details)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [p.userId, cat.code, agency?.id ?? null, agency?.name ?? cat.agencyLabel, locationId, description, b.anonymous, no, { clientRef: b.clientRef }],
        )
      ).rows[0];
      await c.query(`insert into tip_events (tip_id, kind, actor_kind, payload) values ($1, 'received', 'system', '{}')`, [tip.id]);
      if (agency) {
        await this.transition(c, tip.id, 'route', 'system', { agency: agency.name });
        await notify(c, await agencyStaff(c, agency.id), {
          type: 'tip_received',
          grp: 'reports',
          title: 'New tip',
          body: `New ${cat.label.toLowerCase()} tip${building ? ` at ${building.postcode}` : ''}.`,
          link: `/agency/tips/${tip.id}`,
        });
      }
      await this.audit.write({ actorId: p.userId, action: 'tip.sent', entity: 'tip', entityId: tip.id, payload: { category: cat.code, anonymous: b.anonymous, routed: !!agency } }, c);
      return { id: tip.id, publicNo: no, routedTo: agency?.name ?? null };
    });
  }

  async mine(p: Principal, tab: 'all' | 'waiting' | 'paid' | 'declined') {
    const filter: Record<string, string> = {
      all: 'true',
      waiting: `t.state in ('sent', 'in_queue', 'more_info', 'claim_review')`,
      paid: `t.state in ('approved_held', 'available')`,
      declined: `t.state in ('declined', 'closed_no_result', 'found_false', 'withdrawn')`,
    };
    const r = await this.db.query(
      `select t.id, t.public_no, t.category, t.state, t.agency_label, t.created_at, c.approved_kobo
         from tips t left join tip_claims c on c.tip_id = t.id
        where t.user_id = $1 and ${filter[tab]} order by t.created_at desc`,
      [p.userId],
    );
    return r.rows.map((t) => ({
      id: t.id,
      publicNo: t.public_no,
      category: tipCategory(t.category)?.label ?? t.category,
      state: t.state,
      status: tipStatus(t.state, t.agency_label),
      bounty: t.approved_kobo ? formatNaira(t.approved_kobo) : null,
      createdAt: t.created_at,
    }));
  }

  async detail(p: Principal, id: string) {
    const t = (
      await this.db.query(
        `select t.*, l.postcode, l.area_label, c.approved_kobo, c.outcome from tips t left join locations l on l.id = t.location_id left join tip_claims c on c.tip_id = t.id where t.id = $1 and t.user_id = $2`,
        [id, p.userId],
      )
    ).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Tip not found.');
    const events = await this.db.query(`select kind, payload, at from tip_events where tip_id = $1 and public order by id`, [id]);
    const cats = await this.categories();
    const cat = cats.find((c) => c.code === t.category);
    const at = (k: string) => events.rows.find((e) => e.kind === k)?.at ?? null;
    const release = t.approved_kobo
      ? (await this.db.query(`select min(available_at) as at from wallet_ledger where reference = $1 and type = 'bounty' and amount_kobo > 0`, [`tip:${id}`])).rows[0]?.at
      : null;
    const steps = [
      { key: 'received', label: 'Received', sub: 'Checked by our team', at: at('received'), done: true },
      { key: 'route', label: `Sent to ${t.agency_label}`, sub: t.agency_id ? 'Routed by category' : 'Waiting for the agency to join', at: at('route'), done: !!at('route') },
      { key: 'result', label: 'Verified result', sub: 'Agency records an outcome', at: at('outcome_recorded'), done: !!at('outcome_recorded') },
      { key: 'paid', label: 'Bounty paid', sub: 'To your wallet', at: at('approve'), done: !!at('approve') },
    ];
    return {
      id,
      publicNo: t.public_no,
      category: tipCategory(t.category)?.label ?? t.category,
      agency: t.agency_label,
      description: t.description,
      place: t.postcode ? `${t.postcode}, ${t.area_label}` : null,
      anonymous: t.anonymous,
      state: t.state,
      status: tipStatus(t.state, t.agency_label),
      steps,
      bountyRange: cat?.bounty?.text ?? null,
      bounty: t.approved_kobo ? { amount: formatNaira(t.approved_kobo), releaseAt: release } : null,
      updates: events.rows
        .filter((e) => ['info_added', 'ask_more', 'decline', 'mark_false', 'close'].includes(e.kind))
        .map((e) => ({ kind: e.kind, text: e.payload.text ?? e.payload.comment ?? e.payload.reason ?? '', at: e.at })),
      canAddInfo: ['in_queue', 'more_info', 'sent'].includes(t.state),
      canWithdraw: ['sent', 'in_queue', 'more_info'].includes(t.state),
      createdAt: t.created_at,
    };
  }

  async addInfo(p: Principal, id: string, text: string) {
    const t = (await this.db.query(`select state, agency_id from tips where id = $1 and user_id = $2`, [id, p.userId])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Tip not found.');
    if (!['sent', 'in_queue', 'more_info'].includes(t.state)) throw new AppError(409, 'invalid_transition', 'This tip is closed to new information.');
    await this.db.tx(async (c) => {
      if (t.state === 'more_info') await this.transition(c, id, 'info_added', 'tipper', { text });
      else await c.query(`insert into tip_events (tip_id, kind, actor_kind, payload) values ($1, 'info_added', 'tipper', $2)`, [id, { text }]);
      if (t.agency_id) await notify(c, await agencyStaff(c, t.agency_id), { type: 'tip_info', grp: 'reports', title: 'Tip updated', body: 'A tipper added information.', link: `/agency/tips/${id}` });
    });
    return { ok: true };
  }

  async withdraw(p: Principal, id: string) {
    const own = (await this.db.query(`select 1 from tips where id = $1 and user_id = $2`, [id, p.userId])).rowCount;
    if (!own) throw new AppError(404, 'not_found', 'Tip not found.');
    await this.db.tx((c) => this.transition(c, id, 'withdraw', 'tipper'));
    return { ok: true };
  }

  // ---------------------------------------------------------------- agency side

  async queue(p: Principal, agencyId: string, tab: 'new' | 'claims' | 'closed') {
    await this.agencies.requireStaff(p, agencyId);
    await this.agencies.requireHandles(agencyId, 'tips');
    const filter = { new: `t.state in ('in_queue', 'more_info')`, claims: `t.state = 'claim_review'`, closed: `t.state not in ('in_queue', 'more_info', 'claim_review')` }[tab];
    const r = await this.db.query(
      `select t.id, t.public_no, t.category, t.state, t.description, t.anonymous, t.created_at, l.postcode, l.area_label, u.display_name, c.outcome, c.suggested_kobo, c.approved_kobo
         from tips t join users u on u.id = t.user_id left join locations l on l.id = t.location_id left join tip_claims c on c.tip_id = t.id
        where t.agency_id = $1 and ${filter} order by t.created_at desc limit 100`,
      [agencyId],
    );
    // Tipper identity is held by us; the agency sees an anonymous number unless the tipper agreed.
    return r.rows.map((t) => ({
      id: t.id,
      publicNo: t.public_no,
      category: tipCategory(t.category)?.label ?? t.category,
      state: t.state,
      description: t.description,
      place: t.postcode ? `${t.postcode}, ${t.area_label}` : null,
      tipper: t.anonymous ? `Anonymous tipper ${t.public_no}` : t.display_name,
      outcome: t.outcome ?? null,
      bountyKobo: t.approved_kobo != null ? Number(t.approved_kobo) : t.suggested_kobo != null ? Number(t.suggested_kobo) : null,
      createdAt: t.created_at,
    }));
  }

  /** One tip for the agency: facts, claim, pool and the full history. Never the tipper's identity unless they agreed. */
  async agencyDetail(p: Principal, agencyId: string, tipId: string) {
    await this.agencies.requireStaff(p, agencyId);
    const t = (
      await this.db.query(
        `select t.*, l.postcode, l.area_label, u.display_name, c.outcome, c.severity as claim_severity, c.suggested_kobo, c.approved_kobo, c.decline_reason, c.recovered_kobo, c.fee_kobo, c.created_at as claimed_at
           from tips t join users u on u.id = t.user_id left join locations l on l.id = t.location_id left join tip_claims c on c.tip_id = t.id
          where t.id = $1 and t.agency_id = $2`,
        [tipId, agencyId],
      )
    ).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Tip not found.');
    const events = await this.db.query(`select kind, actor_kind, payload, at from tip_events where tip_id = $1 order by id`, [tipId]);
    const rate = (await this.db.query(`select basis, tiers, cap_kobo from bounty_rates where agency_id = $1 and category = $2 and active`, [agencyId, t.category])).rows[0];
    const pool = (
      await this.db.query(
        `select coalesce(b.available_kobo, 0)::bigint as kobo from wallets w left join wallet_balances b on b.wallet_id = w.id where w.owner_type = 'bounty_pool' and w.owner_id = $1`,
        [agencyId],
      )
    ).rows[0];
    const LABEL: Record<string, string> = {
      received: 'Tip received',
      route: 'Sent to your agency',
      ask_more: 'You asked for more information',
      info_added: 'Tipper added information',
      outcome_recorded: 'Result recorded',
      approve: 'Bounty approved',
      decline: 'Bounty declined',
      close: 'Closed without a result',
      mark_false: 'Marked false',
      withdraw: 'Tipper withdrew the tip',
      hold_ends: 'Bounty released to the tipper',
    };
    const p0 = (e: { payload: Record<string, unknown> }) => (e.payload.text ?? e.payload.comment ?? e.payload.reason ?? null) as string | null;
    return {
      id: t.id,
      publicNo: t.public_no,
      category: tipCategory(t.category)?.label ?? t.category,
      state: t.state,
      description: t.description,
      place: t.postcode ? `${t.postcode}, ${t.area_label}` : null,
      tipper: t.anonymous ? `Anonymous tipper ${t.public_no}` : t.display_name,
      createdAt: t.created_at,
      claim: t.outcome
        ? {
            outcome: t.outcome,
            severity: t.claim_severity,
            suggestedKobo: Number(t.suggested_kobo),
            approvedKobo: t.approved_kobo == null ? null : Number(t.approved_kobo),
            declineReason: t.decline_reason,
            recoveredKobo: t.recovered_kobo == null ? null : Number(t.recovered_kobo),
            feeKobo: t.fee_kobo == null ? null : Number(t.fee_kobo),
            recordedAt: t.claimed_at,
          }
        : null,
      rate: rate ? { basis: rate.basis, percent: rate.tiers?.percent == null ? null : Number(rate.tiers.percent), minKobo: rate.tiers?.min == null ? null : Number(rate.tiers.min), maxKobo: rate.tiers?.max == null ? null : Number(rate.tiers.max), capKobo: rate.cap_kobo == null ? null : Number(rate.cap_kobo) } : null,
      poolKobo: pool ? Number(pool.kobo) : null,
      feeBps: (await agencyFee(this.db.pool, agencyId)).bps,
      holdDays: BOUNTY_HOLD_DAYS,
      actions: availableEvents(tipMachine, t.state, 'agency_admin'),
      history: events.rows.map((e) => ({ kind: e.kind, label: LABEL[e.kind] ?? e.kind, note: e.kind === 'outcome_recorded' ? null : p0(e), amountKobo: e.payload.amount ?? null, at: e.at })),
    };
  }

  async act(
    p: Principal,
    agencyId: string,
    tipId: string,
    b: { event: 'ask_more' | 'outcome_recorded' | 'approve' | 'decline' | 'close' | 'mark_false'; comment?: string; outcome?: string; severity?: 'standard' | 'high'; amountKobo?: number; recoveredKobo?: number; reason?: string },
  ) {
    await this.agencies.requireStaff(p, agencyId, b.event === 'approve' ? ['agency_admin', 'agency_finance'] : ['agency_admin']);
    const t = (await this.db.query(`select t.*, a.name as agency_name from tips t join agencies a on a.id = t.agency_id where t.id = $1 and t.agency_id = $2`, [tipId, agencyId])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Tip not found.');
    const link = `/tips/${tipId}`;

    return this.db.tx(async (c) => {
      switch (b.event) {
        case 'ask_more': {
          if (!b.comment?.trim()) throw new AppError(422, 'comment_required', 'Say what you need from the tipper.');
          await this.transition(c, tipId, 'ask_more', 'agency_admin', { comment: b.comment.trim() });
          await notify(c, [t.user_id], { type: 'tip_more_info', grp: 'tips', title: 'More information needed', body: `${t.agency_name} needs more information about your tip.`, link });
          break;
        }
        case 'outcome_recorded': {
          if (!['arrest', 'seizure', 'rescue', 'case_opened'].includes(b.outcome ?? '')) throw new AppError(422, 'outcome_required', 'Choose the result: arrest, seizure, rescue or case opened.');
          const r = (await c.query(`select basis, tiers, cap_kobo from bounty_rates where agency_id = $1 and category = $2 and active`, [agencyId, t.category])).rows[0];
          const rate = r ? toRate(r) : null;
          if (rate?.basis === 'percent_capped' && !b.recoveredKobo) throw new AppError(422, 'recovered_required', 'Enter the value recovered or seized. This rate pays a share of it.');
          const suggested = suggestBounty(rate, { severity: b.severity ?? 'standard', recoveredKobo: b.recoveredKobo });
          await c.query(`insert into tip_claims (tip_id, outcome, severity, suggested_kobo, recovered_kobo) values ($1, $2, $3, $4, $5)`, [
            tipId,
            b.outcome,
            b.severity ?? 'standard',
            suggested,
            b.recoveredKobo ?? null,
          ]);
          await this.transition(c, tipId, 'outcome_recorded', 'agency_admin', { outcome: b.outcome });
          await notify(c, [t.user_id], { type: 'tip_result', grp: 'tips', title: 'Your tip led to a result', body: `${t.agency_name} recorded a result. The bounty is being reviewed.`, link });
          break;
        }
        case 'approve': {
          const status = (await c.query(`select status from agencies where id = $1`, [agencyId])).rows[0].status;
          if (status === 'offboarding' || status === 'offboarded') throw new AppError(409, 'pool_closed', 'Your bounty pool is being paid back to you, so new bounties cannot be approved.');
          const claim = (await c.query(`select * from tip_claims where tip_id = $1 for update`, [tipId])).rows[0];
          const amount = b.amountKobo ?? claim?.suggested_kobo ?? 0;
          if (!amount || amount <= 0) throw new AppError(422, 'amount_required', 'Enter the bounty amount.');
          const rate = (await c.query(`select cap_kobo from bounty_rates where agency_id = $1 and category = $2`, [agencyId, t.category])).rows[0];
          if (rate?.cap_kobo && amount > Number(rate.cap_kobo)) throw new AppError(422, 'over_cap', `This is above the cap of ${formatNaira(Number(rate.cap_kobo))}.`);
          // Officers and staff of the receiving agency cannot claim its bounties (Rewards doc).
          const conflict = await c.query(
            `select 1 from user_roles ur left join stations s on ur.scope_type = 'station' and s.id = ur.scope_id
              where ur.user_id = $1 and ((ur.scope_type = 'agency' and ur.scope_id = $2) or s.agency_id = $2) limit 1`,
            [t.user_id, agencyId],
          );
          if (conflict.rowCount) throw new AppError(409, 'staff_conflict', 'Staff of this agency cannot claim its bounties.');
          const pool = (
            await c.query(
              `select w.id, coalesce(b.available_kobo, 0)::bigint as kobo from wallets w left join wallet_balances b on b.wallet_id = w.id
                where w.owner_type = 'bounty_pool' and w.owner_id = $1`,
              [agencyId],
            )
          ).rows[0];
          // The platform fee comes from the pool on top of the bounty; the tipper gets the full amount.
          const fee = await agencyFee(c, agencyId);
          const feeKobo = bountyFee(amount, fee.bps);
          if (!pool || Number(pool.kobo) < amount + feeKobo) {
            throw new AppError(
              409,
              'pool_low',
              `Your pool has ${formatNaira(Number(pool?.kobo ?? 0))}. This bounty and the ${percent(fee.bps)} platform fee need ${formatNaira(amount + feeKobo)}. Add funds before approving.`,
            );
          }
          const tipperWallet = (
            await c.query(`insert into wallets (owner_type, owner_id) values ('user', $1) on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`, [t.user_id])
          ).rows[0].id;
          const journal = randomUUID();
          await c.query(
            `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo, available_at) values
               ($1, 'bounty', $3, $4, $5, $6, now() + make_interval(days => $7)), ($2, 'bounty', -$3::bigint, $4, $5, $6, now())`,
            [tipperWallet, pool.id, amount, `tip:${tipId}`, journal, `Bounty, tip ${t.public_no}`, BOUNTY_HOLD_DAYS],
          );
          if (feeKobo > 0) {
            const fees = (await c.query(`select id from wallets where owner_type = 'platform_fees' and owner_id is null`)).rows[0].id;
            await c.query(
              `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values
                 ($1, 'payment', -$3::bigint, $4, $5, $6), ($2, 'payment', $3, $4, $5, $6)`,
              [pool.id, fees, feeKobo, `tip:${tipId}`, journal, `Platform fee ${percent(fee.bps)}, tip ${t.public_no}`],
            );
          }
          await c.query(`update tip_claims set approved_kobo = $2, decided_by = $3, fee_bps = $4, fee_kobo = $5 where tip_id = $1`, [tipId, amount, p.userId, fee.bps, feeKobo]);
          await this.transition(c, tipId, 'approve', 'agency_admin', { amount });
          await notify(c, [t.user_id], {
            type: 'bounty_approved',
            grp: 'money',
            title: 'Bounty approved',
            body: `${formatNaira(amount)} was added to your wallet. It can be withdrawn in ${BOUNTY_HOLD_DAYS} days.`,
            link,
          });
          await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: 'bounty.approve', entity: 'tip', entityId: tipId, payload: { amount, feeKobo, feeBps: fee.bps, journal } }, c);
          break;
        }
        case 'decline': {
          if (!b.reason?.trim()) throw new AppError(422, 'reason_required', 'A reason is required.');
          await c.query(`update tip_claims set decline_reason = $2, decided_by = $3 where tip_id = $1`, [tipId, b.reason.trim(), p.userId]);
          await this.transition(c, tipId, 'decline', 'agency_admin', { reason: b.reason.trim() });
          await notify(c, [t.user_id], { type: 'bounty_declined', grp: 'tips', title: 'No bounty for this tip', body: 'Your tip did not qualify for a bounty. Thank you for reporting.', link });
          await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: 'bounty.decline', entity: 'tip', entityId: tipId, reason: b.reason.trim() }, c);
          break;
        }
        case 'close':
          await this.transition(c, tipId, 'close', 'agency_admin', { reason: b.reason ?? '' });
          await notify(c, [t.user_id], { type: 'tip_closed', grp: 'tips', title: 'Tip closed', body: `${t.agency_name} closed your tip without a result. Thank you for reporting.`, link });
          break;
        case 'mark_false': {
          if (!b.reason?.trim()) throw new AppError(422, 'reason_required', 'Say why the tip is false.');
          await this.transition(c, tipId, 'mark_false', 'agency_admin', { reason: b.reason.trim() });
          // Same trust consequence as a false alarm, with the same appeal path.
          await c.query(
            `update trust_scores set score = greatest(0, score - 10), band = case when score - 10 < 40 then 'low' when score - 10 < 75 then 'normal' else 'high' end, updated_at = now() where user_id = $1`,
            [t.user_id],
          );
          await notify(c, [t.user_id], { type: 'tip_false', grp: 'account', title: 'Tip not confirmed', body: 'This tip could not be confirmed. It affects your trust score. You can appeal.', link });
          await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: 'tip.mark_false', entity: 'tip', entityId: tipId, reason: b.reason.trim() }, c);
          break;
        }
      }
      return { state: (await c.query(`select state from tips where id = $1`, [tipId])).rows[0].state };
    });
  }
}

/** A bounty_rates row as the domain's BountyRate. */
export function toRate(r: { basis: BountyRate['basis']; tiers: BountyRate['tiers'] | null; cap_kobo: string | number | null }): BountyRate {
  return { basis: r.basis, tiers: r.tiers ?? {}, capKobo: r.cap_kobo == null ? null : Number(r.cap_kobo) };
}
