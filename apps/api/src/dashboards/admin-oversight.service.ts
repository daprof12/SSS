// Platform admin oversight boards: "Audit log" (+ entry), "AI and LLM" (+ review detail) and
// "Messaging" CRM (+ campaign results). The audit log is read only and hash-chained; AI only
// suggests, a person decides; marketing goes only to people who opted in.
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import { requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { dateWhere } from '../core/date-range';
import { AppError } from '../core/http';
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { WHATSAPP, type WhatsAppAdapter } from '../adapters/whatsapp';
import { notify } from '../reports/shared';

const MONTH = `date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`;
const TODAY = `date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`;
const ROLE: Record<string, string> = {
  platform_admin: 'Platform admin',
  platform_finance: 'Finance',
  platform_support: 'Support',
  agency_admin: 'Agency admin',
  agency_finance: 'Agency finance',
  head: 'Station head',
  dispatcher: 'Dispatcher',
  officer: 'Officer',
  technician: 'Technician',
  owner: 'Home owner',
  citizen: 'Citizen',
  system: 'System',
};
/** Plain words for the audit actions people look for most; the rest are spelled out from the code. */
const ACTION: Record<string, string> = {
  'device.live_view': 'Opened a live camera view',
  'device.light_on': 'Turned a street light on',
  'device.flash_test': 'Ran a street light flash test',
  'device.station_alerted': 'Alerted a station about a device',
  'repair.opened': 'Opened a repair ticket',
  'repair.visit_booked': 'Booked a technician visit',
  'repair.reported': 'Reported a device problem',
  'fine.waived': 'Waived a fine after appeal',
  'fine.overturned': 'Overturned a false alarm',
  'fine.issued': 'Issued a fine',
  'invoice.waive': 'Waived an invoice',
  'incident.transfer': 'Reassigned a report to another station',
  'incident.merge': 'Merged two reports',
  'incident.split': 'Split a joined report',
  'station.areas_set': 'Changed the area a station covers',
  'station.settings': 'Changed station settings',
  'routing.rule_set': 'Changed a routing rule',
  'access.refused': 'Tried something without permission',
  'stock.added': 'Added stock',
  'stock.transferred': 'Moved stock between stores',
  'donation.payout_run': 'Ran the donations payout',
  'payout.hold': 'Held a payout',
  'payout.release': 'Released a payout',
  'settings.bounty_fee': 'Changed the bounty fee',
  'ai.settings': 'Changed AI settings',
  'ai.switch': 'Used an AI safety switch',
  'ai.review': 'Reviewed an AI translation',
  'crm.sent': 'Sent a message campaign',
  'crm.approved': 'Approved a message campaign',
  'statement.download': 'Downloaded a statement',
  'auth.sign_out': 'Signed out',
};
const describe = (action: string) => ACTION[action] ?? (action.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
const MONEY_ACTIONS = `(action like '%waive%' or action like '%refund%' or action like 'fine.overturn%')`;
const LANG: Record<string, string> = { en: 'English', pcm: 'Pidgin', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' };

export interface AiSettings {
  provider: string;
  primary: string;
  fallback: string;
  region: string;
  paused: boolean;
  translationPaused: boolean;
  useFallback: boolean;
  monthlyLimitKobo: number;
  reviewBelowPct: number;
}

/** Cost per message in kobo (mock rates until the provider contracts are signed). */
export const CRM_RATES = { sms: 400, whatsapp: 800 } as const;
/** Sends to more people than this need a second platform admin to approve. */
export const CRM_APPROVAL_ABOVE = 500;
export type CrmChannel = 'push' | 'sms' | 'whatsapp';
export interface CrmAudience extends LocationFilter {
  who: Array<'citizen' | 'officer' | 'head' | 'agency_admin'>;
  agencyId?: string;
  /** Set by the server for an agency's own campaigns: its staff, and citizens whose home is in its stations' areas. */
  scopeAgencyId?: string;
}
/** An agency sending from its own Messaging page. */
export type CrmScope = { agencyId: string } | undefined;

@Injectable()
export class AdminOversightService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(SMS) private readonly sms: SmsAdapter,
    @Inject(WHATSAPP) private readonly whatsapp: WhatsAppAdapter,
  ) {}

  // ---------------------------------------------------------------- audit log

  private auditFrom = `audit_log a
    left join users u on u.id = a.actor_id
    left join incidents i on a.entity = 'incident' and i.id::text = a.entity_id
    left join locations il on il.id = i.location_id
    left join devices d on a.entity = 'device' and d.id::text = a.entity_id
    left join properties dp on dp.id = d.property_id
    left join locations dl on dl.id = coalesce(d.location_id, dp.location_id)
    left join stations s on a.entity = 'station' and s.id::text = a.entity_id
    left join locations sl on sl.id = s.location_id`;
  private auditPostcode = `coalesce(a.payload->>'postcode', il.postcode, dl.postcode, sl.postcode)`;

  private auditWhere(b: { days?: number; actor?: string; action?: string; postcode?: string; from?: string; to?: string }, args: unknown[]) {
    const parts: string[] = [];
    if (b.from || b.to) parts.push(dateWhere(b, args, 'a.at'));
    else {
      args.push(b.days ?? 7);
      parts.push(`a.at > now() - make_interval(days => $${args.length})`);
    }
    if (b.actor) {
      args.push(b.actor);
      parts.push(`a.actor_id = $${args.length}`);
    }
    if (b.action === 'refused') parts.push(`a.action = 'access.refused'`);
    else if (b.action === 'money') parts.push(MONEY_ACTIONS.replace(/action/g, 'a.action'));
    else if (b.action) {
      args.push(`${b.action}.%`);
      parts.push(`a.action like $${args.length}`);
    }
    if (b.postcode?.trim()) {
      args.push(b.postcode.trim());
      parts.push(`replace(${this.auditPostcode}, ' ', '') ilike replace($${args.length}, ' ', '') || '%'`);
    }
    return parts.join(' and ');
  }

  private entryRow(e: Record<string, any>) {
    return {
      id: Number(e.id),
      at: e.at,
      person: e.person ?? (e.actor_id ? 'Unknown' : 'System'),
      role: ROLE[e.actor_role] ?? (e.actor_role ? e.actor_role : e.actor_id ? '—' : 'System'),
      action: `${describe(e.action)}${e.reason ? `. Reason: ${e.reason}` : ''}`,
      code: e.action,
      postcode: e.postcode ?? null,
      result: e.action === 'access.refused' ? 'Refused' : 'Allowed',
    };
  }

  async auditLog(p: Principal, b: { days?: number; actor?: string; action?: string; postcode?: string; from?: string; to?: string }) {
    requirePerm(p, 'platform.audit');
    const args: unknown[] = [];
    const where = this.auditWhere(b, args);
    const rows = (
      await this.db.query(
        `select a.id, a.at, a.actor_id, a.actor_role, a.action, a.reason, u.display_name as person, ${this.auditPostcode} as postcode
           from ${this.auditFrom} where ${where} order by a.id desc limit 200`,
        args,
      )
    ).rows;
    const s = (
      await this.db.query(
        `select count(*) filter (where at >= ${TODAY})::int as today,
                count(*) filter (where action = 'device.live_view' and at > now() - interval '7 days')::int as live,
                count(*) filter (where ${MONEY_ACTIONS} and at > now() - interval '7 days')::int as money,
                count(*) filter (where action = 'access.refused' and at > now() - interval '7 days')::int as refused
           from audit_log where at > now() - interval '7 days'`,
      )
    ).rows[0];
    const people = (
      await this.db.query(
        `select distinct a.actor_id as id, u.display_name as name from audit_log a join users u on u.id = a.actor_id
          where a.at > now() - interval '30 days' and a.actor_role is not null and a.actor_role not in ('citizen', 'owner') order by 2`,
      )
    ).rows;
    return {
      stats: { today: s.today, liveViews: s.live, refundsWaivers: s.money, refused: s.refused },
      people,
      actions: [
        ['device', 'Devices and cameras'],
        ['incident', 'Reports'],
        ['station', 'Stations'],
        ['fine', 'Fines'],
        ['payout', 'Payouts'],
        ['stock', 'Inventory'],
        ['ai', 'AI'],
        ['crm', 'Messaging'],
        ['money', 'Refunds and waivers'],
        ['refused', 'Refused attempts'],
      ].map(([code, label]) => ({ code, label })),
      entries: rows.map((e) => this.entryRow(e)),
    };
  }

  async auditCsv(p: Principal, b: { days?: number; actor?: string; action?: string; postcode?: string }) {
    const { entries } = await this.auditLog(p, b);
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'audit.export', entity: 'audit_log', payload: { filters: b, rows: entries.length } });
    return ['Entry,Time,Person,Role,Action,Postcode,Result', ...entries.map((e) => [e.id, new Date(e.at).toISOString(), e.person, e.role, e.action, e.postcode, e.result].map(q).join(','))].join('\n');
  }

  async auditEntry(p: Principal, id: number) {
    requirePerm(p, 'platform.audit');
    const e = (
      await this.db.query(
        `select a.*, host(a.ip) as ip_text, u.display_name as person, ${this.auditPostcode} as postcode,
                -- Integrity: this row's hash recomputed from its content and the row before it.
                a.hash = digest(coalesce(encode(a.prev_hash, 'hex'), '') || '|' || jsonb_build_object(
                  'actor_id', a.actor_id, 'actor_role', a.actor_role, 'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id,
                  'reason', a.reason, 'ip', host(a.ip), 'payload', a.payload, 'at', to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'sha256')
                and a.prev_hash is not distinct from (select x.hash from audit_log x where x.id < a.id order by x.id desc limit 1) as intact
           from ${this.auditFrom} where a.id = $1`,
        [id],
      )
    ).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Entry not found.');
    const related = e.entity_id
      ? (
          await this.db.query(
            `select a.id, a.at, a.action, a.reason from audit_log a where a.entity_id = $1 and a.id <> $2 and a.at between $3::timestamptz - interval '1 day' and $3::timestamptz + interval '1 day' order by a.at limit 10`,
            [e.entity_id, id, e.at],
          )
        ).rows
      : [];
    return {
      ...this.entryRow(e),
      reason: e.reason,
      target: [e.entity.replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase()), e.entity_id ? String(e.entity_id).slice(0, 8) : null, e.postcode].filter(Boolean).join(', '),
      ip: e.ip_text ?? null,
      userAgent: e.payload?.userAgent ?? null,
      secondApproval: e.payload?.approvedBy ? 'Given' : 'Not required',
      payload: e.payload,
      intact: !!e.intact,
      related: related.map((r) => ({ id: Number(r.id), at: r.at, action: `${describe(r.action)}${r.reason ? `: ${r.reason}` : ''}` })),
    };
  }

  // ---------------------------------------------------------------- AI and LLM

  async aiSettings(c: Queryable = this.db.pool): Promise<AiSettings> {
    return (await c.query(`select value from platform_settings where key = 'ai'`)).rows[0]?.value;
  }

  async ai(p: Principal) {
    requirePerm(p, 'platform.ai');
    const st = await this.aiSettings();
    const s = (
      await this.db.query(
        `select count(*) filter (where at >= ${TODAY})::int as today, count(*) filter (where at >= ${TODAY} and failed)::int as failed,
                coalesce(avg(ms) filter (where at > now() - interval '7 days'), 0)::int as avg_ms,
                coalesce(avg(ms) filter (where use_case = 'brief' and at > now() - interval '7 days'), 0)::int as brief_ms,
                count(*) filter (where at > now() - interval '7 days')::int as week, count(*) filter (where at > now() - interval '7 days' and to_review)::int as week_review,
                coalesce(sum(cost_kobo) filter (where at >= ${MONTH}), 0)::bigint as cost
           from ai_requests`,
      )
    ).rows[0];
    const days = (
      await this.db.query(
        `select to_char(g.d, 'YYYY-MM-DD') as day, count(r.id)::int as n
           from generate_series((now() at time zone 'Africa/Lagos')::date - 13, (now() at time zone 'Africa/Lagos')::date, interval '1 day') g(d)
           left join ai_requests r on (r.at at time zone 'Africa/Lagos')::date = g.d::date group by g.d order by g.d`,
      )
    ).rows;
    const uses = (
      await this.db.query(
        `select u.*, (select count(*)::int from ai_requests r where r.use_case = u.code and r.at > now() - interval '30 days') as n from ai_use_cases u order by sort`,
      )
    ).rows;
    const queue = await this.reviewQueueRows();
    const langs = (await this.db.query(`select value from platform_settings where key = 'ai_languages'`)).rows[0]?.value ?? {};
    const cost = Number(s.cost);
    const MODEL: Record<string, string> = { primary: st.primary, small: st.fallback, vision: `${st.primary} (vision)` };
    return {
      settings: st,
      stats: {
        requestsToday: s.today,
        failedToday: s.failed,
        avgSeconds: Math.round(s.avg_ms / 100) / 10,
        briefSeconds: Math.round(s.brief_ms / 100) / 10,
        reviewPct: s.week ? Math.round((s.week_review / s.week) * 100) : 0,
        costMonthKobo: cost,
        limitKobo: st.monthlyLimitKobo,
      },
      useCases: uses.map((u) => ({
        code: u.code,
        name: u.name,
        model: st.useFallback ? st.fallback : MODEL[u.tier],
        mode: u.mode,
        checkPct: u.check_pct,
        status: st.paused || (u.code === 'translate' && st.translationPaused) ? 'paused' : u.status,
        requests30d: u.n,
      })),
      languages: Object.entries(LANG).map(([code, name]) => ({ code, name, status: langs[code] ?? 'test_needed' })),
      perDay: days.map((d) => ({ day: d.day, n: d.n })),
      alerts: [
        ...(queue.length ? [{ tone: 'critical', title: `${queue.length} ${queue.length === 1 ? 'translation is' : 'translations are'} waiting for review`, body: `Oldest is ${Math.max(1, Math.round((Date.now() - +new Date(queue[queue.length - 1]!.signed_at)) / 3_600_000))} hours old.` }] : []),
        ...(cost >= st.monthlyLimitKobo * 0.75 ? [{ tone: 'warning', title: `Cost is at ${Math.round((cost / st.monthlyLimitKobo) * 100)}% of the monthly limit`, body: 'AI pauses non-urgent jobs at 100%.' }] : []),
        ...(st.paused ? [{ tone: 'critical', title: 'All AI is paused', body: 'Briefs fall back to the plain report. Statements are taken as audio and text and wait for translation.' }] : []),
      ],
      reviewWaiting: queue.length,
    };
  }

  async saveAiSettings(p: Principal, b: Partial<Pick<AiSettings, 'provider' | 'primary' | 'fallback' | 'region' | 'monthlyLimitKobo'>>) {
    requirePerm(p, 'platform.ai');
    return this.db.tx(async (c) => {
      const before = await this.aiSettings(c);
      const after = { ...before, ...b };
      await c.query(`update platform_settings set value = $1, updated_by = $2, updated_at = now() where key = 'ai'`, [after, p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'ai.settings', entity: 'platform_settings', entityId: 'ai', payload: { before, after } }, c);
      return { message: 'Saved.' };
    });
  }

  /** Safety switches: pause all AI, pause translation, or run on the fallback model. */
  async aiSwitch(p: Principal, b: { paused?: boolean; translationPaused?: boolean; useFallback?: boolean }) {
    requirePerm(p, 'platform.ai');
    return this.db.tx(async (c) => {
      const before = await this.aiSettings(c);
      await c.query(`update platform_settings set value = value || $1::jsonb, updated_by = $2, updated_at = now() where key = 'ai'`, [JSON.stringify(b), p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'ai.switch', entity: 'platform_settings', entityId: 'ai', payload: { before, change: b } }, c);
      const m =
        b.paused === true ? 'All AI is paused. Briefs use the plain report; statements wait for translation.'
        : b.paused === false ? 'AI is back on.'
        : b.translationPaused === true ? 'Translation is paused. Statements wait for a person.'
        : b.translationPaused === false ? 'Translation is back on.'
        : b.useFallback ? 'Running on the fallback model.' : 'Back on the primary model.';
      return { message: m };
    });
  }

  async setUseCase(p: Principal, code: string, status: 'live' | 'testing' | 'paused') {
    requirePerm(p, 'platform.ai');
    const r = await this.db.query(`update ai_use_cases set status = $2 where code = $1 returning name`, [code, status]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Use case not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'ai.use_case', entity: 'ai_use_case', entityId: code, payload: { status } });
    return { message: `${r.rows[0].name}: ${status}.` };
  }

  /** Signed statement versions whose AI English was below the confidence line, not yet reviewed. */
  private async reviewQueueRows() {
    const st = await this.aiSettings();
    return (
      await this.db.query(
        `select s.id, s.number, v.version, v.language, v.ai_confidence, coalesce(array_length(v.flagged_words, 1), 0) as flagged, v.signed_at
           from statement_versions v join statements s on s.id = v.statement_id
          where v.ai_confidence is not null and v.ai_confidence * 100 < $1
            and not exists (select 1 from ai_reviews r where r.statement_id = v.statement_id and r.version = v.version)
          order by v.signed_at desc`,
        [st.reviewBelowPct],
      )
    ).rows;
  }

  async reviewQueue(p: Principal) {
    requirePerm(p, 'platform.ai');
    return (await this.reviewQueueRows()).map((r) => ({
      statementId: r.id,
      number: r.number,
      version: r.version,
      language: LANG[r.language] ?? r.language,
      confidencePct: Math.round(Number(r.ai_confidence) * 100),
      flagged: r.flagged,
      signedAt: r.signed_at,
    }));
  }

  async review(p: Principal, statementId: string) {
    requirePerm(p, 'platform.ai');
    const st = await this.aiSettings();
    const v = (
      await this.db.query(
        `select s.number, s.state, s.translator_check, v.* from statement_versions v join statements s on s.id = v.statement_id
          where v.statement_id = $1 order by v.version desc limit 1`,
        [statementId],
      )
    ).rows[0];
    if (!v) throw new AppError(404, 'not_found', 'Statement not found or not signed yet.');
    const done = (await this.db.query(`select r.*, u.display_name as by from ai_reviews r join users u on u.id = r.decided_by where r.statement_id = $1 and r.version = $2`, [statementId, v.version])).rows[0];
    const trend = (
      await this.db.query(
        `select count(*)::int as n, count(*) filter (where r.decision <> 'looks_right')::int as corrected
           from ai_reviews r join statement_versions x on x.statement_id = r.statement_id and x.version = r.version
          where x.language = $1 and r.decided_at > now() - interval '7 days'`,
        [v.language],
      )
    ).rows[0];
    const flagged: string[] = v.flagged_words ?? [];
    const conf = v.ai_confidence == null ? null : Math.round(Number(v.ai_confidence) * 100);
    return {
      statementId,
      number: v.number,
      version: v.version,
      language: LANG[v.language] ?? v.language,
      confidencePct: conf,
      thresholdPct: st.reviewBelowPct,
      signedAt: v.signed_at,
      original: v.original_text,
      english: v.english_text,
      flagged,
      hasAudio: !!v.audio_id,
      status: v.state === 'change_requested' ? 'Re-record asked' : v.translator_check === 'requested' ? 'With a translator' : 'Signed by reporter',
      cause: flagged.some((w) => /\d/.test(w)) && flagged.some((w) => /[A-Za-z]/.test(w)) ? 'Place names and numbers' : flagged.some((w) => /\d/.test(w)) ? 'Times or numbers' : flagged.length ? 'Place names and slang' : 'Low overall confidence',
      decision: done ? { decision: done.decision, note: done.note, by: done.by, at: done.decided_at } : null,
      trend: { reviewed: trend.n, corrected: trend.corrected },
    };
  }

  /** "Looks right" / "Add note" / "Send to translator" / "Ask reporter to re-record". The signed record never changes. */
  async decideReview(p: Principal, statementId: string, b: { decision: 'looks_right' | 'note' | 'translator' | 'rerecord'; note?: string }) {
    requirePerm(p, 'platform.ai');
    const note = b.note?.trim() ?? '';
    if (b.decision !== 'looks_right' && note.length < 3) throw new AppError(422, 'validation_failed', 'A note is required.', { fields: [{ field: 'note', message: 'A note is required.' }] });
    return this.db.tx(async (c) => {
      const s = (await c.query(`select s.*, (select max(version) from statement_versions v where v.statement_id = s.id) as version from statements s where s.id = $1 for update`, [statementId])).rows[0];
      if (!s?.version) throw new AppError(404, 'not_found', 'Statement not found or not signed yet.');
      const r = await c.query(`insert into ai_reviews (statement_id, version, decision, note, decided_by) values ($1, $2, $3, $4, $5) on conflict do nothing`, [statementId, s.version, b.decision, note || null, p.userId]);
      if (!r.rowCount) throw new AppError(409, 'already_reviewed', 'Someone has already reviewed this version.');
      if (b.decision === 'translator' && s.translator_check !== 'requested') {
        await c.query(`update statements set translator_check = 'requested', translator_note = $2 where id = $1`, [statementId, note]);
        await c.query(`insert into statement_access (statement_id, actor_id, action, note) values ($1, $2, 'translator_check', $3)`, [statementId, p.userId, note]);
      }
      if (b.decision === 'rerecord') {
        if (s.state === 'signed') {
          const last = (await c.query(`select * from statement_versions where statement_id = $1 and version = $2`, [statementId, s.version])).rows[0];
          await c.query(
            `update statements set state = 'change_requested', change_note = $2, draft_language = $3, draft_original = $4, draft_english = $5, draft_confidence = $6, draft_flagged = $7 where id = $1`,
            [statementId, note, last.language, last.original_text, last.english_text, last.ai_confidence, last.flagged_words],
          );
        }
        await notify(c, [s.citizen_id], {
          type: 'statement_change',
          grp: 'reports',
          title: 'Please check your statement',
          body: `We could not be sure of some words in your statement: "${note}". Record it again or correct it, then sign. Your signed version is kept.`,
          link: `/statements/${statementId}`,
        });
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'ai.review', entity: 'statement', entityId: statementId, payload: { version: s.version, decision: b.decision, note } }, c);
      const msg = { looks_right: 'Marked as right. Added to the test set.', note: 'Note added beside the AI text.', translator: 'Sent to a certified translator.', rerecord: 'Asked the reporter to record it again.' };
      return { message: msg[b.decision] };
    });
  }

  // ---------------------------------------------------------------- CRM messaging

  /** Everyone the campaign would reach: role, agency, place (home for citizens, station for staff). */
  private async audience(c: Queryable, a: CrmAudience, kind: 'marketing' | 'safety') {
    if (!a.who?.length) return [];
    const scope = a.scopeAgencyId ?? null;
    const args: unknown[] = [a.who, scope ?? a.agencyId ?? null, scope];
    const homeWhere = locationWhere(a, args, 'hl');
    const stationWhere = locationWhere(a, args, 'sl');
    const rows = (
      await c.query(
        `select u.id, u.phone, u.whatsapp_opt_in,
                exists (select 1 from sessions x where x.user_id = u.id and x.revoked_at is null) as has_push,
                exists (select 1 from notification_prefs np where np.user_id = u.id and np.grp = 'marketing' and not np.enabled) as opted_out
           from users u
          where u.status = 'active'
            and exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role = any($1::text[])
                          and (case when ur.role in ('citizen', 'owner')
                                    -- An agency reaches citizens whose home is in one of its stations' areas.
                                    then $3::uuid is null or exists (
                                      select 1 from saved_places sp join locations h on h.id = sp.location_id
                                        join station_areas sa on (sa.level = 'area' and sa.area_id = h.area_id) or (sa.level = 'district' and sa.area_id = h.district_id) or (sa.level = 'lga' and sa.area_id = h.lga_id)
                                        join stations s3 on s3.id = sa.station_id and s3.agency_id = $3
                                       where sp.user_id = u.id and sp.is_home)
                                    else $2::uuid is null or (ur.scope_type = 'agency' and ur.scope_id = $2) or (ur.scope_type = 'station' and ur.scope_id in (select id from stations where agency_id = $2))
                               end))
            and (exists (select 1 from saved_places sp join locations hl on hl.id = sp.location_id where sp.user_id = u.id and sp.is_home and ${homeWhere})
                 or exists (select 1 from user_roles ur join stations s on ur.scope_type = 'station' and s.id = ur.scope_id join locations sl on sl.id = s.location_id where ur.user_id = u.id and ${stationWhere})
                 or (${homeWhere === 'true' ? 'true' : 'false'}))`,
        args,
      )
    ).rows;
    return rows.filter((r) => kind === 'safety' || !r.opted_out).map((r) => ({ ...r, opted_out: kind === 'marketing' && r.opted_out }));
  }

  /** Platform CRM needs the platform permission; an agency's own messaging needs agency operations. */
  private crmGate(p: Principal, scope: CrmScope) {
    if (scope) requirePerm(p, 'agency.operations', scope.agencyId);
    else requirePerm(p, 'platform.crm');
  }

  private async campaignIn(id: string, scope: CrmScope) {
    const m = (await this.db.query(`select agency_id from crm_campaigns where id = $1`, [id])).rows[0];
    if (!m || (scope ? m.agency_id !== scope.agencyId : m.agency_id !== null)) throw new AppError(404, 'not_found', 'Campaign not found.');
  }

  async audienceSize(p: Principal, a: CrmAudience & { kind?: 'marketing' | 'safety'; channels?: CrmChannel[] }, scope?: CrmScope) {
    this.crmGate(p, scope);
    a = { ...a, scopeAgencyId: scope?.agencyId };
    const kind = a.kind ?? 'marketing';
    const all = await this.audience(this.db.pool, a, kind);
    const ch = a.channels ?? ['push', 'sms'];
    const optedOut = kind === 'marketing' ? (await this.audience(this.db.pool, a, 'safety')).length - all.length : 0;
    return {
      people: all.length,
      noPush: all.filter((r) => !r.has_push).length,
      noPhone: all.filter((r) => !r.phone).length,
      optedOut,
      cost: {
        smsKobo: ch.includes('sms') ? all.filter((r) => r.phone && !r.has_push).length * CRM_RATES.sms : 0,
        whatsappKobo: ch.includes('whatsapp') ? all.filter((r) => r.phone && r.whatsapp_opt_in).length * CRM_RATES.whatsapp : 0,
      },
      needsApproval: all.length > CRM_APPROVAL_ABOVE,
    };
  }

  /** Compose → save draft, request approval, schedule, send now, or send a test to me. */
  async compose(
    p: Principal,
    b: {
      action: 'draft' | 'request_approval' | 'schedule' | 'send' | 'test';
      title: string;
      body: string;
      kind: 'marketing' | 'safety';
      urgent?: boolean;
      audience: CrmAudience;
      channels: CrmChannel[];
      languages?: string[];
      link?: string;
      sendAt?: string;
    },
    scope?: CrmScope,
  ) {
    this.crmGate(p, scope);
    b = { ...b, audience: { ...b.audience, scopeAgencyId: scope?.agencyId, agencyId: scope?.agencyId ?? b.audience.agencyId } };
    if (b.channels.includes('sms') && b.body.length > 160) {
      throw new AppError(422, 'validation_failed', `SMS must be 160 characters or fewer, now ${b.body.length - 160} over.`, { fields: [{ field: 'body', message: `SMS must be 160 characters or fewer, now ${b.body.length - 160} over.` }] });
    }
    if (b.action === 'test') {
      await notify(this.db.pool, [p.userId], { type: 'crm_test', grp: b.kind === 'safety' ? 'safety' : 'marketing', title: `Test: ${b.title}`, body: b.body, link: b.link ?? '/notifications' });
      return { message: 'Test sent to you.' };
    }
    if (!b.audience.who?.length) throw new AppError(422, 'validation_failed', 'Choose who gets it.', { fields: [{ field: 'who', message: 'Choose who gets it.' }] });
    let sendAt: Date | null = null;
    if (b.action === 'schedule') {
      sendAt = b.sendAt ? new Date(b.sendAt) : null;
      if (!sendAt || Number.isNaN(+sendAt) || sendAt < new Date()) throw new AppError(422, 'validation_failed', 'Choose a time in the future.', { fields: [{ field: 'sendAt', message: 'Choose a time in the future.' }] });
    }
    // Quiet hours 22:00 to 06:00 unless urgent: a "send now" then goes out at 06:00.
    const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }));
    let quiet = false;
    if (b.action === 'send' && !b.urgent && (hour >= 22 || hour < 6)) {
      quiet = true;
      const six = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
      if (hour >= 22) six.setDate(six.getDate() + 1);
      sendAt = new Date(`${six.getFullYear()}-${String(six.getMonth() + 1).padStart(2, '0')}-${String(six.getDate()).padStart(2, '0')}T06:00:00+01:00`);
    }
    return this.db.tx(async (c) => {
      const people = await this.audience(c, b.audience, b.kind);
      if (['send', 'schedule', 'request_approval'].includes(b.action) && !people.length) throw new AppError(422, 'no_audience', 'No one matches this audience.');
      const big = people.length > CRM_APPROVAL_ABOVE;
      if (big && (b.action === 'send' || b.action === 'schedule')) throw new AppError(409, 'needs_approval', `This goes to ${people.length} people. Large sends need a second approver: request approval.`);
      const state = b.action === 'draft' ? 'draft' : b.action === 'request_approval' ? 'awaiting_approval' : sendAt ? 'scheduled' : 'sent';
      const id = (
        await c.query(
          `insert into crm_campaigns (title, body, kind, urgent, audience, channels, languages, link, state, send_at, created_by, agency_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [b.title.trim(), b.body.trim(), b.kind, !!b.urgent, b.audience, b.channels, b.languages ?? ['en'], b.link ?? null, state, sendAt, p.userId, scope?.agencyId ?? null],
        )
      ).rows[0].id;
      if (state === 'awaiting_approval') {
        const others = (
          scope
            ? await c.query(`select user_id from user_roles where role = 'agency_admin' and scope_id = $2 and user_id <> $1`, [p.userId, scope.agencyId])
            : await c.query(`select user_id from user_roles where role = 'platform_admin' and user_id <> $1`, [p.userId])
        ).rows.map((x) => x.user_id);
        await notify(c, others, { type: 'crm_approval', grp: 'team', title: 'Message waiting for approval', body: `"${b.title.trim()}" to ${people.length} people.`, link: scope ? `/agency/messaging/${id}` : `/admin/crm/${id}` });
      }
      if (state === 'sent') await this.deliver(c, id);
      await this.audit.write({ actorId: p.userId, actorRole: scope ? 'agency_admin' : 'platform_admin', action: state === 'sent' ? 'crm.sent' : `crm.${state}`, entity: 'crm_campaign', entityId: id, payload: { people: people.length, channels: b.channels, kind: b.kind, agencyId: scope?.agencyId } }, c);
      const msg =
        state === 'draft' ? 'Draft saved.'
        : state === 'awaiting_approval' ? `Sent to another ${scope ? 'agency' : 'platform'} admin to approve.`
        : state === 'scheduled' ? (quiet ? 'It is quiet hours, so it goes out at 06:00. Mark it urgent to send now.' : 'Scheduled.')
        : `Sent to ${people.length} ${people.length === 1 ? 'person' : 'people'}.`;
      return { id, state, message: msg };
    });
  }

  /** Push first (with the in-app inbox); no app session → SMS; then WhatsApp for those opted in. */
  private async deliver(c: Queryable, id: string) {
    const m = (await c.query(`select * from crm_campaigns where id = $1`, [id])).rows[0];
    const people = await this.audience(c, m.audience, m.kind);
    const grp = m.kind === 'safety' ? 'safety' : 'marketing';
    for (const u of people) {
      const n = (
        await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'crm', $2, 'in_app', $3, $4, $5) returning id`, [u.id, grp, m.title, m.body, m.link ?? '/notifications'])
      ).rows[0].id;
      let pushed = m.channels.includes('push') && u.has_push;
      let sms: Date | null = null;
      let wa: Date | null = null;
      let failure: string | null = null;
      if (!pushed && m.channels.includes('sms')) {
        if (!u.phone) failure = 'number_not_valid';
        else
          try {
            await this.sms.send({ to: u.phone, body: `${m.title}: ${m.body}${m.kind === 'marketing' ? ' Reply STOP to opt out.' : ''}`, urgent: m.urgent });
            sms = new Date();
          } catch {
            failure = 'number_not_valid';
          }
      }
      if (!pushed && !sms && m.channels.includes('whatsapp')) {
        if (!u.whatsapp_opt_in) failure = failure ?? 'whatsapp_not_opted_in';
        else
          try {
            await this.whatsapp.send({ to: u.phone, body: `${m.title}: ${m.body}` });
            wa = new Date();
            failure = null;
          } catch {
            failure = 'number_not_valid';
          }
      }
      if (!pushed && !sms && !wa && !failure) failure = 'no_channel';
      if (!m.channels.includes('push')) pushed = false;
      await c.query(
        `insert into crm_deliveries (campaign_id, user_id, notification_id, pushed_at, sms_at, whatsapp_at, failure) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (campaign_id, user_id) do update set notification_id = excluded.notification_id, pushed_at = coalesce(excluded.pushed_at, crm_deliveries.pushed_at),
           sms_at = coalesce(excluded.sms_at, crm_deliveries.sms_at), whatsapp_at = coalesce(excluded.whatsapp_at, crm_deliveries.whatsapp_at), failure = excluded.failure`,
        [id, u.id, n, pushed ? new Date() : null, sms, wa, failure],
      );
    }
    await c.query(`update crm_campaigns set state = 'sent', sent_at = coalesce(sent_at, now()) where id = $1`, [id]);
    return people.length;
  }

  /** Job: scheduled campaigns that are due; push not read after 10 minutes moves to SMS. */
  async crmDue(): Promise<number> {
    return this.db.tx(async (c) => {
      const due = (await c.query(`select id from crm_campaigns where state = 'scheduled' and send_at <= now() for update skip locked`)).rows;
      for (const d of due) await this.deliver(c, d.id);
      const stale = (
        await c.query(
          `select x.campaign_id, x.user_id, u.phone, m.title, m.body, m.kind, m.urgent from crm_deliveries x
             join crm_campaigns m on m.id = x.campaign_id join users u on u.id = x.user_id
             left join notifications n on n.id = x.notification_id
            where x.pushed_at < now() - interval '10 minutes' and x.sms_at is null and n.read_at is null and 'sms' = any(m.channels) and m.sent_at > now() - interval '1 day'`,
        )
      ).rows;
      for (const s of stale) {
        try {
          if (!s.phone) throw new Error('no phone');
          await this.sms.send({ to: s.phone, body: `${s.title}: ${s.body}${s.kind === 'marketing' ? ' Reply STOP to opt out.' : ''}`, urgent: s.urgent });
          await c.query(`update crm_deliveries set sms_at = now() where campaign_id = $1 and user_id = $2`, [s.campaign_id, s.user_id]);
        } catch {
          await c.query(`update crm_deliveries set failure = 'phone_off' where campaign_id = $1 and user_id = $2`, [s.campaign_id, s.user_id]);
        }
      }
      return due.length + stale.length;
    });
  }

  async campaigns(p: Principal, scope?: CrmScope) {
    this.crmGate(p, scope);
    const r = (
      await this.db.query(
        `select m.id, m.title, m.kind, m.state, m.channels, m.send_at, m.sent_at, m.created_at, u.display_name as by,
                count(x.user_id)::int as people,
                count(x.user_id) filter (where x.pushed_at is not null or x.sms_at is not null or x.whatsapp_at is not null)::int as reached
           from crm_campaigns m join users u on u.id = m.created_by left join crm_deliveries x on x.campaign_id = m.id
          where m.agency_id is not distinct from $1
          group by m.id, u.display_name order by m.created_at desc limit 100`,
        [scope?.agencyId ?? null],
      )
    ).rows;
    return r.map((m) => ({ id: m.id, title: m.title, kind: m.kind, state: m.state, channels: m.channels, sendAt: m.send_at, sentAt: m.sent_at, by: m.by, people: m.people, reachedPct: m.people ? Math.round((m.reached / m.people) * 100) : null }));
  }

  async campaign(p: Principal, id: string, scope?: CrmScope) {
    this.crmGate(p, scope);
    await this.campaignIn(id, scope);
    const m = (
      await this.db.query(`select m.*, u.display_name as by, a.display_name as approver from crm_campaigns m join users u on u.id = m.created_by left join users a on a.id = m.approved_by where m.id = $1`, [id])
    ).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'Campaign not found.');
    const x = (
      await this.db.query(
        `select count(*)::int as people,
                count(*) filter (where pushed_at is not null)::int as push_sent, count(*) filter (where pushed_at is not null and n.read_at is not null)::int as push_read,
                count(*) filter (where sms_at is not null)::int as sms_sent, count(*) filter (where pushed_at is not null and sms_at is not null)::int as moved_sms,
                count(*) filter (where whatsapp_at is not null)::int as wa_sent,
                count(*) filter (where pushed_at is not null and n.read_at is not null and sms_at is null)::int as push_only,
                count(*) filter (where pushed_at is null and sms_at is null and whatsapp_at is null)::int as nothing,
                count(*) filter (where failure is not null)::int as failed,
                count(*) filter (where n.read_at is not null)::int as read
           from crm_deliveries x left join notifications n on n.id = x.notification_id where x.campaign_id = $1`,
        [id],
      )
    ).rows[0];
    const reasons = (await this.db.query(`select failure, count(*)::int as n from crm_deliveries where campaign_id = $1 and failure is not null group by failure`, [id])).rows;
    const smsK = x.sms_sent * CRM_RATES.sms;
    const waK = x.wa_sent * CRM_RATES.whatsapp;
    const reached = x.people - x.nothing;
    return {
      id: m.id,
      title: m.title,
      body: m.body,
      kind: m.kind,
      state: m.state,
      channels: m.channels,
      audience: m.audience,
      by: m.by,
      sentAt: m.sent_at,
      sendAt: m.send_at,
      canApprove: m.state === 'awaiting_approval' && m.created_by !== p.userId,
      stats: { people: x.people, reached, reachedPct: x.people ? Math.round((reached / x.people) * 100) : 0, readPct: x.people ? Math.round((x.read / x.people) * 100) : 0, failed: x.failed, costKobo: smsK + waK },
      channelsTable: [
        { channel: 'Push', sent: x.push_sent, delivered: x.push_sent, read: x.push_read, failed: 0 },
        { channel: 'SMS', sent: x.sms_sent, delivered: x.sms_sent, read: null, failed: reasons.filter((r) => ['number_not_valid', 'phone_off', 'dnd'].includes(r.failure)).reduce((a, r) => a + r.n, 0) },
        { channel: 'WhatsApp', sent: x.wa_sent, delivered: x.wa_sent, read: null, failed: reasons.find((r) => r.failure === 'whatsapp_not_opted_in')?.n ?? 0 },
      ],
      reasons: ['number_not_valid', 'phone_off', 'opted_out', 'whatsapp_not_opted_in', 'dnd', 'no_channel'].map((k) => ({ code: k, n: reasons.find((r) => r.failure === k)?.n ?? 0 })),
      fallback: { pushOnly: x.push_only, movedToSms: x.moved_sms, movedToWhatsapp: x.wa_sent, nothing: x.nothing },
      cost: { smsKobo: smsK, whatsappKobo: waK, totalKobo: smsK + waK },
      approvedBy: m.approver ? { name: m.approver } : null,
    };
  }

  async approve(p: Principal, id: string, scope?: CrmScope) {
    this.crmGate(p, scope);
    await this.campaignIn(id, scope);
    return this.db.tx(async (c) => {
      const m = (await c.query(`select * from crm_campaigns where id = $1 for update`, [id])).rows[0];
      if (!m) throw new AppError(404, 'not_found', 'Campaign not found.');
      if (m.state !== 'awaiting_approval') throw new AppError(409, 'not_waiting', 'This campaign is not waiting for approval.');
      if (m.created_by === p.userId) throw new AppError(403, 'second_approver', 'A different platform admin must approve it.');
      await c.query(`update crm_campaigns set approved_by = $2, state = case when send_at > now() then 'scheduled' else state end where id = $1`, [id, p.userId]);
      const n = m.send_at && new Date(m.send_at) > new Date() ? 0 : await this.deliver(c, id);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'crm.approved', entity: 'crm_campaign', entityId: id, payload: { approvedBy: p.userId, people: n } }, c);
      return { message: n ? `Approved and sent to ${n} people.` : 'Approved. It goes out at the scheduled time.' };
    });
  }

  /** "Resend to unreached": SMS to people nothing reached, where there is a number. */
  async resend(p: Principal, id: string, scope?: CrmScope) {
    this.crmGate(p, scope);
    await this.campaignIn(id, scope);
    const rows = (
      await this.db.query(
        `select x.user_id, u.phone, m.title, m.body, m.kind, m.urgent from crm_deliveries x join users u on u.id = x.user_id join crm_campaigns m on m.id = x.campaign_id
          where x.campaign_id = $1 and x.pushed_at is null and x.sms_at is null and x.whatsapp_at is null`,
        [id],
      )
    ).rows;
    let n = 0;
    for (const r of rows) {
      if (!r.phone) continue;
      try {
        await this.sms.send({ to: r.phone, body: `${r.title}: ${r.body}${r.kind === 'marketing' ? ' Reply STOP to opt out.' : ''}`, urgent: r.urgent });
        await this.db.query(`update crm_deliveries set sms_at = now(), failure = null where campaign_id = $1 and user_id = $2`, [id, r.user_id]);
        n++;
      } catch {
        /* still unreached */
      }
    }
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'crm.resend', entity: 'crm_campaign', entityId: id, payload: { tried: rows.length, reached: n } });
    return { message: rows.length ? `Sent again by SMS to ${n} of ${rows.length}.` : 'Everyone was reached.' };
  }

  async duplicate(p: Principal, id: string, scope?: CrmScope) {
    this.crmGate(p, scope);
    await this.campaignIn(id, scope);
    const r = await this.db.query(
      `insert into crm_campaigns (title, body, kind, urgent, audience, channels, languages, link, created_by, agency_id)
       select title, body, kind, urgent, audience, channels, languages, link, $2, agency_id from crm_campaigns where id = $1 returning id`,
      [id, p.userId],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Campaign not found.');
    return { id: r.rows[0].id, message: 'Copied as a draft.' };
  }

  async resultsCsv(p: Principal, id: string, scope?: CrmScope) {
    const c = await this.campaign(p, id, scope);
    const lines = [
      'Channel,Sent,Delivered,Read,Failed',
      ...c.channelsTable.map((r) => [r.channel, r.sent, r.delivered, r.read ?? 'n/a', r.failed].join(',')),
      '',
      'Reason,Count',
      ...c.reasons.map((r) => `${r.code},${r.n}`),
    ];
    return lines.join('\n');
  }

  async consent(p: Principal) {
    requirePerm(p, 'platform.crm');
    const r = (
      await this.db.query(
        `select count(*)::int as users,
                count(*) filter (where exists (select 1 from notification_prefs np where np.user_id = u.id and np.grp = 'marketing' and not np.enabled))::int as opted_out,
                count(*) filter (where u.whatsapp_opt_in)::int as whatsapp,
                count(*) filter (where u.phone is null)::int as no_phone
           from users u where u.status = 'active'`,
      )
    ).rows[0];
    return { users: r.users, optedOut: r.opted_out, whatsappOptIn: r.whatsapp, noPhone: r.no_phone };
  }
}
