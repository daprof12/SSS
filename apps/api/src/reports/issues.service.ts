// Public issues (Public Issues doc §1–2; Report Tracking B3): report, merge count, fix, confirm.
import { Inject, Injectable } from '@nestjs/common';
import { applyEvent, FIX_CONFIRMATIONS, ISSUE_MERGE_RADIUS_M, issueCategories, issueCategory, issueMachine, issueStatus, type IssueState } from '@erp/domain';
import { POSTCODE, PostcodeUnavailable, type PostcodeAdapter } from '../adapters/postcode';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { agencyStaff, notify, publicNo, receivingAgency } from './shared';

type Severity = 'small' | 'dangerous' | 'blocking';
const RANK: Record<Severity, number> = { small: 0, dangerous: 1, blocking: 2 };

interface Where {
  postcode?: string;
  lat?: number;
  lng?: number;
}

@Injectable()
export class IssuesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
  ) {}

  async categories() {
    const out = [];
    for (const c of issueCategories) {
      const a = await receivingAgency(this.db.pool, c.agencyKinds);
      out.push({ code: c.code, label: c.label, icon: c.icon, subtypes: c.subtypes, urgent: !!c.urgent, agencyLabel: a?.name ?? c.agencyLabel, joined: !!a });
    }
    return out;
  }

  /** Building and point for a report; never fails on the address service if GPS is there. */
  private async resolve(w: Where) {
    let building = null;
    try {
      building = w.postcode ? await this.postcode.lookup(w.postcode) : w.lat != null ? await this.postcode.nearest(w.lat, w.lng!, 100) : null;
    } catch (e) {
      if (!(e instanceof PostcodeUnavailable)) throw e;
    }
    if (w.postcode && !building) throw new AppError(422, 'postcode_not_found', 'We could not find that place. Check the postcode or use where you are.', { fields: [{ field: 'where', message: 'Check the postcode.' }] });
    const lat = building?.lat ?? w.lat;
    const lng = building?.lng ?? w.lng;
    if (lat == null || lng == null) throw new AppError(422, 'location_required', 'Add where it is: your location or a postcode.', { fields: [{ field: 'where', message: 'Add where it is.' }] });
    return { building, lat, lng };
  }

  private async nearestCase(c: Queryable, category: string, lat: number, lng: number) {
    return (
      await c.query(
        `select id, public_no, report_count, people_count, state from issue_cases
          where category = $1 and state <> 'fixed' and st_dwithin(geom, st_setsrid(st_makepoint($3, $2), 4326)::geography, $4)
          order by st_distance(geom, st_setsrid(st_makepoint($3, $2), 4326)::geography) limit 1`,
        [category, lat, lng, ISSUE_MERGE_RADIUS_M],
      )
    ).rows[0];
  }

  /** "[48] people already reported this" before sending (board "Public issue road form"). */
  async nearby(category: string, w: Where) {
    if (!issueCategory(category)) throw new AppError(422, 'validation_failed', 'Choose a category.');
    const { lat, lng } = await this.resolve(w);
    const c = await this.nearestCase(this.db.pool, category, lat, lng);
    return c ? { caseId: c.id, publicNo: c.public_no, reports: c.report_count, people: c.people_count, state: c.state } : null;
  }

  async create(p: Principal, b: Where & { category: string; subtype?: string; severity: Severity; description?: string; anonymous: boolean; clientRef: string }) {
    const cat = issueCategory(b.category);
    if (!cat) throw new AppError(422, 'validation_failed', 'Choose a category.', { fields: [{ field: 'category', message: 'Choose a category.' }] });
    const description = b.description?.trim() ?? '';
    // Board copy. Photos come next; until then a few words are required.
    if (description.length < 10) throw new AppError(422, 'validation_failed', 'Photo or a few words needed so the team can find it.', { fields: [{ field: 'description', message: 'Photo or a few words needed so the team can find it.' }] });
    if (b.subtype && !cat.subtypes.includes(b.subtype)) throw new AppError(422, 'validation_failed', 'Choose what it is.', { fields: [{ field: 'subtype', message: 'Choose what it is.' }] });

    const prior = (await this.db.query(`select case_id from issue_reports where client_ref = $1 and user_id = $2`, [b.clientRef, p.userId])).rows[0];
    if (prior) return this.summary(prior.case_id, { duplicate: true });

    const { building, lat, lng } = await this.resolve(b);
    const out = await this.db.tx(async (c) => {
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
      const existing = await this.nearestCase(c, cat.code, lat, lng);

      if (existing) {
        const mine = await c.query(`select id from issue_reports where case_id = $1 and user_id = $2`, [existing.id, p.userId]);
        if (mine.rowCount) {
          // One person's repeat reports count once (TRD); keep the new words on the case.
          await c.query(`insert into issue_events (case_id, kind, actor_kind, payload) values ($1, 'more_detail', 'citizen', $2)`, [existing.id, { text: description }]);
          return { caseId: existing.id as string, joined: true, already: true };
        }
        await c.query(
          `insert into issue_reports (case_id, user_id, subtype, severity, description, anonymous, client_ref) values ($1, $2, $3, $4, $5, $6, $7)`,
          [existing.id, p.userId, b.subtype ?? null, b.severity, description, b.anonymous, b.clientRef],
        );
        await c.query(
          `update issue_cases set report_count = report_count + 1,
                  people_count = (select count(distinct user_id) from issue_reports where case_id = $1),
                  last_at = now(), updated_at = now(),
                  severity = case when $2 > (case severity when 'small' then 0 when 'dangerous' then 1 else 2 end) then $3 else severity end
            where id = $1`,
          [existing.id, RANK[b.severity], b.severity],
        );
        await c.query(`insert into issue_events (case_id, kind, actor_kind, payload) values ($1, 'joined', 'citizen', '{}')`, [existing.id]);
        const kase = (await c.query(`select report_count, agency_id from issue_cases where id = $1`, [existing.id])).rows[0];
        // Tell the agency at milestones so the count stays visible without spamming.
        if (kase.agency_id && [5, 10, 25, 50, 100].includes(kase.report_count)) {
          await notify(c, await agencyStaff(c, kase.agency_id), { type: 'issue_count', grp: 'reports', title: 'More people reported this', body: `${kase.report_count} people have now reported this ${cat.label.toLowerCase()}.`, link: `/agency/issues/${existing.id}` });
        }
        return { caseId: existing.id as string, joined: true, already: false };
      }

      const agency = await receivingAgency(c, cat.agencyKinds);
      const no = await publicNo(c, 'issue_cases', 'P');
      const kase = (
        await c.query(
          `insert into issue_cases (public_no, category, agency_id, agency_label, location_id, geom, severity)
           values ($1, $2, $3, $4, $5, st_setsrid(st_makepoint($7, $6), 4326)::geography, $8) returning id`,
          [no, cat.code, agency?.id ?? null, agency?.name ?? cat.agencyLabel, locationId, lat, lng, b.severity],
        )
      ).rows[0];
      await c.query(
        `insert into issue_reports (case_id, user_id, subtype, severity, description, anonymous, client_ref) values ($1, $2, $3, $4, $5, $6, $7)`,
        [kase.id, p.userId, b.subtype ?? null, b.severity, description, b.anonymous, b.clientRef],
      );
      await c.query(`insert into issue_events (case_id, kind, actor_kind, payload) values ($1, 'reported', 'citizen', '{}')`, [kase.id]);
      if (agency) {
        await notify(c, await agencyStaff(c, agency.id), {
          type: 'issue_new',
          grp: 'reports',
          title: 'New public issue',
          body: `${cat.label}${building ? ` at ${building.postcode}` : ''}${b.severity === 'blocking' ? ', blocking' : b.severity === 'dangerous' ? ', dangerous' : ''}.`,
          link: `/agency/issues/${kase.id}`,
        });
      }
      return { caseId: kase.id as string, joined: false, already: false };
    });
    await this.audit.write({ actorId: p.userId, action: out.joined ? 'issue.joined' : 'issue.reported', entity: 'issue_case', entityId: out.caseId, payload: { category: cat.code } });
    return this.summary(out.caseId, { joined: out.joined, already: out.already, urgent: !!cat.urgent });
  }

  private async summary(caseId: string, extra: Record<string, unknown>) {
    const k = (await this.db.query(`select public_no, report_count, people_count from issue_cases where id = $1`, [caseId])).rows[0];
    return { id: caseId, publicNo: k.public_no, reports: k.report_count, people: k.people_count, ...extra };
  }

  async mine(p: Principal) {
    const r = await this.db.query(
      `select k.id, k.public_no, k.category, k.state, k.agency_label, k.report_count, k.people_count, r.created_at, l.postcode
         from issue_reports r join issue_cases k on k.id = r.case_id left join locations l on l.id = k.location_id
        where r.user_id = $1 order by k.state = 'fixed', r.created_at desc`,
      [p.userId],
    );
    return r.rows.map((k) => ({
      id: k.id,
      publicNo: k.public_no,
      category: issueCategory(k.category)?.label ?? k.category,
      state: k.state,
      status: issueStatus(k.state, k.agency_label),
      reports: k.report_count,
      people: k.people_count,
      postcode: k.postcode,
      createdAt: k.created_at,
    }));
  }

  async detail(p: Principal, id: string) {
    const mine = (await this.db.query(`select * from issue_reports where case_id = $1 and user_id = $2`, [id, p.userId])).rows[0];
    if (!mine) throw new AppError(404, 'not_found', 'Report not found.');
    const k = (
      await this.db.query(`select k.*, l.postcode, l.address_text, l.area_label from issue_cases k left join locations l on l.id = k.location_id where k.id = $1`, [id])
    ).rows[0];
    const events = await this.db.query(`select kind, payload, at from issue_events where case_id = $1 and kind <> 'more_detail' order by id`, [id]);
    const LABEL: Record<string, string> = {
      reported: 'Reported',
      joined: 'Someone else reported it',
      assign: `${k.agency_label} took it on`,
      start: 'Work started',
      mark_fixed: `${k.agency_label} says it is fixed`,
      not_fixed: 'A reporter says it is not fixed',
      confirm_fixed: 'Confirmed fixed',
    };
    return {
      id,
      publicNo: k.public_no,
      category: issueCategory(k.category)?.label ?? k.category,
      agency: k.agency_label,
      agencyJoined: !!k.agency_id,
      place: k.postcode ? `${k.address_text}, ${k.postcode}` : 'Location from GPS',
      state: k.state as IssueState,
      status: issueStatus(k.state, k.agency_label),
      severity: k.severity,
      reports: k.report_count,
      people: k.people_count,
      firstAt: k.first_at,
      lastAt: k.last_at,
      targetOn: k.target_on,
      fixNote: k.fix_note,
      mine: { subtype: mine.subtype, severity: mine.severity, description: mine.description, anonymous: mine.anonymous, vote: mine.fixed_vote },
      canVote: k.state === 'awaiting_check' && !mine.fixed_vote,
      timeline: events.rows.map((e) => ({ label: LABEL[e.kind] ?? e.kind, note: e.payload?.note ?? null, at: e.at })),
    };
  }

  private async transition(c: Queryable, caseId: string, event: 'assign' | 'start' | 'mark_fixed' | 'confirm_fixed' | 'not_fixed', actor: 'agency_admin' | 'citizen' | 'system', payload: Record<string, unknown> = {}) {
    const k = (await c.query(`select state from issue_cases where id = $1 for update`, [caseId])).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Report not found.');
    const r = applyEvent(issueMachine, k.state, event, actor);
    if (!r.ok) throw new AppError(r.code === 'actor_not_allowed' ? 403 : 409, r.code, 'That is not possible at this stage.');
    await c.query(`update issue_cases set state = $2, updated_at = now()${r.to === 'fixed' ? ', fixed_at = now()' : ''} where id = $1`, [caseId, r.to]);
    await c.query(`insert into issue_events (case_id, kind, actor_kind, payload) values ($1, $2, $3, $4)`, [caseId, event, actor === 'agency_admin' ? 'agency' : actor, payload]);
    return r.to;
  }

  private async reporters(c: Queryable, caseId: string): Promise<string[]> {
    return (await c.query(`select distinct user_id from issue_reports where case_id = $1`, [caseId])).rows.map((r) => r.user_id);
  }

  /** "Is it fixed?" — enough "yes" closes it, one "no" reopens it (Report Tracking B3). */
  async vote(p: Principal, id: string, vote: 'yes' | 'no') {
    return this.db.tx(async (c) => {
      const mine = (await c.query(`select id, fixed_vote from issue_reports where case_id = $1 and user_id = $2 for update`, [id, p.userId])).rows[0];
      if (!mine) throw new AppError(404, 'not_found', 'Report not found.');
      const k = (await c.query(`select state, agency_id, agency_label, category, people_count from issue_cases where id = $1`, [id])).rows[0];
      if (k.state !== 'awaiting_check') throw new AppError(409, 'not_awaiting_check', 'This is not waiting for a check.');
      if (mine.fixed_vote) throw new AppError(409, 'already_voted', 'You already answered. Thank you.');
      await c.query(`update issue_reports set fixed_vote = $2, voted_at = now() where id = $1`, [mine.id, vote]);
      const label = issueCategory(k.category)?.label.toLowerCase() ?? 'issue';
      if (vote === 'no') {
        await this.transition(c, id, 'not_fixed', 'citizen', { by: 'reporter' });
        // A new fix round: every reporter answers afresh next time, including this one.
        await c.query(`update issue_reports set fixed_vote = null, voted_at = null where case_id = $1`, [id]);
        if (k.agency_id) await notify(c, await agencyStaff(c, k.agency_id), { type: 'issue_reopened', grp: 'reports', title: 'Reported as not fixed', body: `A reporter says the ${label} is not fixed.`, link: `/agency/issues/${id}` });
        return { state: 'reopened' };
      }
      const yes = (await c.query(`select count(*)::int as n from issue_reports where case_id = $1 and fixed_vote = 'yes'`, [id])).rows[0].n;
      if (yes >= Math.min(FIX_CONFIRMATIONS, k.people_count)) {
        await this.transition(c, id, 'confirm_fixed', 'citizen');
        await notify(c, await this.reporters(c, id), { type: 'issue_fixed', grp: 'reports', title: 'Fixed', body: `The ${label} you reported is fixed. Thank you.`, link: `/issues/${id}` });
        return { state: 'fixed' };
      }
      return { state: 'awaiting_check', yes, needed: Math.min(FIX_CONFIRMATIONS, k.people_count) };
    });
  }

  // ---------------------------------------------------------------- agency side

  async queue(p: Principal, agencyId: string) {
    await this.agencies.requireStaff(p, agencyId);
    const r = await this.db.query(
      `select k.id, k.public_no, k.category, k.state, k.severity, k.report_count, k.people_count, k.first_at, k.last_at, k.target_on, l.postcode, l.area_label
         from issue_cases k left join locations l on l.id = k.location_id
        where k.agency_id = $1 order by k.state = 'fixed', k.report_count desc, k.last_at desc limit 200`,
      [agencyId],
    );
    return r.rows.map((k) => ({ ...k, category: issueCategory(k.category)?.label ?? k.category }));
  }

  async act(p: Principal, agencyId: string, caseId: string, b: { event: 'assign' | 'start' | 'mark_fixed'; targetOn?: string; note?: string }) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    const k = (await this.db.query(`select category, agency_label from issue_cases where id = $1 and agency_id = $2`, [caseId, agencyId])).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Report not found.');
    if (b.event === 'mark_fixed' && !b.note?.trim()) throw new AppError(422, 'note_required', 'Say what was done. A photo comes next.');
    const label = issueCategory(k.category)?.label.toLowerCase() ?? 'issue';
    return this.db.tx(async (c) => {
      const to = await this.transition(c, caseId, b.event, 'agency_admin', { note: b.note?.trim() ?? null });
      if (b.event === 'assign' && b.targetOn) await c.query(`update issue_cases set target_on = $2 where id = $1`, [caseId, b.targetOn]);
      if (b.event === 'mark_fixed') await c.query(`update issue_cases set fix_note = $2 where id = $1`, [caseId, b.note!.trim()]);
      const body =
        b.event === 'assign' ? `${k.agency_label} has taken on the ${label} you reported.` : b.event === 'start' ? `Work has started on the ${label} you reported.` : `${k.agency_label} says the ${label} is fixed. Is it?`;
      await notify(c, await this.reporters(c, caseId), { type: `issue_${b.event}`, grp: 'reports', title: b.event === 'mark_fixed' ? 'Is it fixed?' : 'Update on your report', body, link: `/issues/${caseId}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: `issue.${b.event}`, entity: 'issue_case', entityId: caseId }, c);
      return { state: to };
    });
  }
}
