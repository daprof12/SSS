// B7 Statement (boards "Statement record in any language", "Statement review and sign",
// "Statement signed, download", "Station statement view"). An officer or the station asks; the
// citizen speaks or types in their language; an AI English record is made; the citizen corrects it
// and signs with their PIN; the version is sealed and never edited. A change is a new version.
import { languageName, STATEMENT_CAUTION, STATEMENT_CODE, STATEMENT_RULES, statementForm, statementRoleLabel, type StatementRole } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { TRANSLATE, type TranslateAdapter } from '../adapters/translate';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db, type Queryable } from '../core/db';
import { dateWhere } from '../core/date-range';
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { WithdrawalsService } from '../wallet/withdrawals.service';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LAGOS = { timeZone: 'Africa/Lagos' } as const;
const when = (d: Date | string) => new Date(d).toLocaleString('en-GB', { ...LAGOS, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const sealOf = (v: { statementId: string; version: number; language: string; original: string; english: string; signedAt: string }) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const short = (seal: string) => seal.slice(0, 8).toUpperCase();
const STATE_LABEL: Record<string, string> = { requested: 'Waiting for you', draft: 'Draft', signed: 'Signed', change_requested: 'Change asked' };

interface Row {
  id: string;
  number: string;
  incident_id: string;
  citizen_id: string;
  station_id: string | null;
  requested_by: string;
  request_note: string | null;
  state: string;
  draft_language: string | null;
  draft_original: string | null;
  draft_english: string | null;
  draft_confidence: string | null;
  draft_flagged: string[];
  draft_audio_id: string | null;
  change_note: string | null;
  translator_check: string | null;
  translator_note: string | null;
  created_at: Date;
  updated_at: Date;
  type: string;
  postcode: string | null;
  station: string | null;
  requester: string;
  role: StatementRole;
  mode: 'self' | 'in_person';
  agency_id: string | null;
  inc_station_id: string | null;
  inc_agency_id: string | null;
  taken_by: string | null;
  taker: string | null;
  taken_at_place: string | null;
  present_name: string | null;
  present_relation: string | null;
  caution_given_at: Date | null;
  sign_code_hash: string | null;
  sign_code_expires_at: Date | null;
  sign_code_tries: number;
  maker: string;
  maker_phone: string | null;
}

@Injectable()
export class StatementsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(TRANSLATE) private readonly translator: TranslateAdapter,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
    @Inject(SMS) private readonly sms: SmsAdapter,
  ) {}

  private async row(id: string, c: Queryable = this.db.pool, lock = false): Promise<Row | null> {
    return (
      (
        await c.query(
          `select s.*, i.type, l.postcode, st.name as station, ru.display_name as requester, i.station_id as inc_station_id, i.agency_id as inc_agency_id,
                  mu.display_name as maker, mu.phone as maker_phone, tu.display_name as taker
             from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id
             left join stations st on st.id = s.station_id join users ru on ru.id = s.requested_by join users mu on mu.id = s.citizen_id
             left join users tu on tu.id = s.taken_by
            where s.id = $1${lock ? ' for update of s' : ''}`,
          [id],
        )
      ).rows[0] ?? null
    );
  }

  private async versions(id: string, c: Queryable = this.db.pool) {
    return (await c.query(`select * from statement_versions where statement_id = $1 order by version`, [id])).rows;
  }

  /**
   * Who may see and ask for statements on a report (RBAC): officers who are or were on it; the head
   * and dispatchers of the station handling it (or that took the statement); the agency's admins.
   */
  private async isStaff(p: Principal, incidentId: string, stationIds: Array<string | null>, agencyId: string | null): Promise<boolean> {
    for (const sid of stationIds) if (sid && (hasRole(p, 'head', sid) || hasRole(p, 'dispatcher', sid))) return true;
    if (agencyId && hasRole(p, 'agency_admin', agencyId)) return true;
    const on = await this.db.query(`select 1 from incident_units where incident_id = $1 and officer_id = $2 and accepted_at is not null`, [incidentId, p.userId]);
    return !!on.rowCount;
  }

  private async staffRow(p: Principal, id: string, c: Queryable = this.db.pool, lock = false) {
    const s = await this.row(id, c, lock);
    if (!s || !(await this.isStaff(p, s.incident_id, [s.station_id, s.inc_station_id], s.agency_id ?? s.inc_agency_id))) throw new AppError(404, 'not_found', 'Statement not found.');
    return s;
  }

  private async ownRow(p: Principal, id: string, c: Queryable = this.db.pool, lock = false) {
    const s = await this.row(id, c, lock);
    if (!s || s.citizen_id !== p.userId) throw new AppError(404, 'not_found', 'Statement not found.');
    return s;
  }

  private label(s: Row) {
    return `${cap(s.type)}, ${s.postcode ?? 'GPS location'}`;
  }

  // ---------------------------------------------------------------- staff side

  /** People on a report who can be asked: the reporter, people who joined it, and officers on it. */
  async parties(p: Principal, incidentId: string) {
    const i = await this.incidentFor(p, incidentId);
    const people = (
      await this.db.query(
        `select u.id, u.display_name as name, u.phone, x.role from (
           select reporter_id as id, 'complainant' as role, 0 as k from incidents where id = $1
           union select r.reporter_id, 'witness', 1 from incident_reports r where r.incident_id = $1 and r.role = 'joined' and r.reporter_id is not null
           union select u.officer_id, 'officer', 2 from incident_units u where u.incident_id = $1 and u.accepted_at is not null
         ) x join users u on u.id = x.id order by x.k, u.display_name`,
        [incidentId],
      )
    ).rows;
    const asked = (await this.db.query(`select citizen_id, id, number, state, role from statements where incident_id = $1`, [incidentId])).rows;
    const seen = new Set<string>();
    return {
      report: { id: i.id, state: i.state },
      parties: people
        .filter((x) => !seen.has(x.id) && seen.add(x.id))
        .map((x) => {
          const st = asked.find((a) => a.citizen_id === x.id);
          return { userId: x.id, name: x.name, role: x.role as StatementRole, roleLabel: statementRoleLabel(x.role), isMe: x.id === p.userId, hasPhone: !!x.phone, statement: st ? { id: st.id, number: st.number, state: st.state } : null };
        }),
    };
  }

  private async incidentFor(p: Principal, incidentId: string) {
    const i = (await this.db.query(`select id, state, reporter_id, station_id, agency_id, type from incidents where id = $1`, [incidentId])).rows[0];
    if (!i || !(await this.isStaff(p, incidentId, [i.station_id], i.agency_id))) throw new AppError(404, 'not_found', 'This report could not be found.');
    return i;
  }

  /**
   * Ask for a statement on any report, from anyone on it: the reporter (default), someone who joined,
   * an officer on it (including yourself), or another person by phone (a victim, witness or suspect).
   * "self": they write it on their phone and sign with their PIN. "in_person": an officer takes it
   * down and the person confirms it with a code sent to their phone. A suspect's statement is always
   * taken in person, after the caution, with someone of their choice present.
   */
  async request(
    p: Principal,
    incidentId: string,
    b: { note?: string; role?: StatementRole; userId?: string; phone?: string; name?: string; mode?: 'self' | 'in_person'; presentName?: string; presentRelation?: string; place?: string } = {},
  ) {
    const i = await this.incidentFor(p, incidentId);
    if (['pending_cancel', 'cancelled', 'merged'].includes(i.state)) throw new AppError(409, 'invalid_transition', 'This report was cancelled or merged, so it takes no statements.');
    const role: StatementRole = b.role ?? (b.userId && b.userId === p.userId ? 'officer' : 'complainant');
    const mode = role === 'suspect' ? 'in_person' : (b.mode ?? 'self');
    if (role === 'suspect' && !b.presentName?.trim()) {
      throw new AppError(422, 'validation_failed', 'A suspect can have a lawyer or a person of their choice present. Enter who is there.', { fields: [{ field: 'presentName', message: 'Enter who is present.' }] });
    }
    return this.db.tx(async (c) => {
      let maker: string;
      let invited = false;
      if (b.phone) {
        const phone = b.phone.replace(/\s+/g, '');
        if (!/^\+234\d{10}$/.test(phone)) throw new AppError(422, 'validation_failed', 'Enter a Nigerian phone number, like +2348012345678.', { fields: [{ field: 'phone', message: 'Enter a Nigerian phone number.' }] });
        const u = (await c.query(`select id from users where phone = $1`, [phone])).rows[0];
        if (u) maker = u.id;
        else {
          if (!b.name?.trim()) throw new AppError(422, 'validation_failed', 'Enter their full name.', { fields: [{ field: 'name', message: 'Enter their full name.' }] });
          maker = (await c.query(`insert into users (phone, display_name) values ($1, $2) returning id`, [phone, b.name.trim()])).rows[0].id;
          invited = true;
        }
      } else if (b.userId) {
        const ok = await c.query(
          `select 1 where $2::uuid in (select reporter_id from incidents where id = $1
                                       union select reporter_id from incident_reports where incident_id = $1
                                       union select officer_id from incident_units where incident_id = $1 and accepted_at is not null)`,
          [incidentId, b.userId],
        );
        if (!ok.rowCount) throw new AppError(422, 'not_on_report', 'That person is not on this report. Add them by phone instead.');
        maker = b.userId;
      } else maker = i.reporter_id;
      if (role === 'officer' && !(await c.query(`select 1 from officers where user_id = $1`, [maker])).rowCount) {
        throw new AppError(422, 'not_officer', 'Only an officer can make an officer\'s statement.');
      }
      if (mode === 'self' && maker === p.userId && role !== 'officer') throw new AppError(422, 'validation_failed', 'You cannot ask yourself for a citizen statement.');
      const existing = (await c.query(`select id, number from statements where incident_id = $1 and citizen_id = $2`, [incidentId, maker])).rows[0];
      if (existing) throw new AppError(409, 'already_requested', `A statement was already asked for: ${existing.number}. Open it to ask for more detail.`);
      let number = '';
      for (;;) {
        number = `ST-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from statements where number = $1`, [number])).rowCount) break;
      }
      const inPerson = mode === 'in_person';
      const st = await c.query(
        `insert into statements (number, incident_id, citizen_id, station_id, agency_id, requested_by, request_note, role, mode, state, taken_by, taken_at_place, present_name, present_relation)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [number, incidentId, maker, i.station_id, i.agency_id, p.userId, b.note?.trim() || null, role, mode, inPerson ? 'draft' : 'requested', inPerson ? p.userId : null, b.place?.trim() || null, b.presentName?.trim() || null, b.presentRelation?.trim() || null],
      );
      const id = st.rows[0].id;
      const station = i.station_id ? (await c.query(`select name from stations where id = $1`, [i.station_id])).rows[0]?.name : null;
      const actor = hasRole(p, 'head', i.station_id) || hasRole(p, 'dispatcher', i.station_id) ? 'station' : (await c.query(`select 1 from officers where user_id = $1`, [p.userId])).rowCount ? 'officer' : 'station';
      await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, $3, 'statement_requested', $4, $5)`, [
        incidentId,
        p.userId,
        actor,
        { label: inPerson ? `${statementForm(role)} being taken` : role === 'complainant' ? 'Statement requested' : `${statementForm(role)} requested`, statementId: id, role },
        role === 'complainant',
      ]);
      const isOfficer = !!(await c.query(`select 1 from officers where user_id = $1`, [maker])).rowCount;
      if (!inPerson && maker !== p.userId) {
        await notify(c, [maker], {
          type: 'statement_requested',
          grp: 'reports',
          title: 'Statement requested',
          body: `${station ?? 'The station'} asked for your statement as ${statementRoleLabel(role).toLowerCase()} on a ${i.type} report. Speak or type it in the language you are most comfortable in.`,
          link: isOfficer ? `/officer/statements/${id}/write` : `/statements/${id}`,
        });
      }
      if (invited && !inPerson) {
        const phone = (await c.query(`select phone from users where id = $1`, [maker])).rows[0].phone;
        await this.sms.send({ to: phone, body: `${station ?? 'The police'} asked for your statement (${number}). Open the ERP app and sign in with this number to give it.`, urgent: false }).catch(() => undefined);
      }
      await this.audit.write({ actorId: p.userId, action: inPerson ? 'statement.take' : 'statement.request', entity: 'statement', entityId: id, payload: { incidentId, role, mode, invited } }, c);
      this.bus.publishIncident({ incidentId, kind: 'statement_requested', at: new Date().toISOString() });
      const message = inPerson
        ? 'Started. Take the statement down, read it back, then send them the code to confirm.'
        : maker === p.userId
          ? 'Your statement is ready to write.'
          : invited
            ? 'Asked. They were sent a text to sign in and give it.'
            : 'Asked. They are told; you will be told when it is signed.';
      return { id, number, mode, message };
    });
  }

  async forIncident(p: Principal, incidentId: string) {
    await this.incidentFor(p, incidentId);
    const r = await this.db.query(
      `select s.id, s.number, s.state, s.role, s.mode, s.updated_at, u.display_name as maker, (select max(version) from statement_versions v where v.statement_id = s.id) as versions,
              (select signed_at from statement_versions v where v.statement_id = s.id order by version desc limit 1) as signed_at
         from statements s join users u on u.id = s.citizen_id where s.incident_id = $1 order by s.created_at`,
      [incidentId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      number: x.number,
      state: x.state,
      stateLabel: STATE_LABEL[x.state],
      role: x.role,
      form: statementForm(x.role),
      maker: x.maker,
      mode: x.mode,
      versions: x.versions ?? 0,
      signedAt: x.signed_at,
    }));
  }

  /** Station statement view: the reporter's original, the English record, the seal and the access log. Opening it is logged. */
  async staffView(p: Principal, id: string) {
    const s = await this.staffRow(p, id);
    await this.db.query(`insert into statement_access (statement_id, actor_id, action) values ($1, $2, 'opened')`, [id, p.userId]);
    await this.audit.write({ actorId: p.userId, action: 'statement.view', entity: 'statement', entityId: id });
    return this.full(s, true);
  }

  private async full(s: Row, staff: boolean) {
    const versions = await this.versions(s.id);
    const last = versions[versions.length - 1];
    const access = staff
      ? (
          await this.db.query(
            `select a.action, a.note, a.at, u.display_name from statement_access a left join users u on u.id = a.actor_id where a.statement_id = $1 order by a.at desc limit 30`,
            [s.id],
          )
        ).rows
      : [];
    const reporter = staff ? s.maker : null;
    const takerIds = [...new Set(versions.map((v) => v.taken_by).filter(Boolean))];
    const takers = new Map<string, string>(
      takerIds.length ? (await this.db.query(`select id, display_name from users where id = any($1::uuid[])`, [takerIds])).rows.map((u) => [u.id, u.display_name]) : [],
    );
    return {
      id: s.id,
      number: s.number,
      state: s.state,
      stateLabel: STATE_LABEL[s.state],
      role: s.role,
      roleLabel: statementRoleLabel(s.role),
      form: statementForm(s.role),
      mode: s.mode,
      maker: s.maker,
      takenBy: s.taker,
      place: s.taken_at_place,
      present: s.present_name ? { name: s.present_name, relation: s.present_relation } : null,
      caution: s.role === 'suspect' ? { text: STATEMENT_CAUTION, givenAt: s.caution_given_at } : null,
      codeSentTo: staff && s.sign_code_expires_at && new Date(s.sign_code_expires_at) > new Date() && s.maker_phone ? `•••• ${s.maker_phone.slice(-4)}` : null,
      makerHasPhone: !!s.maker_phone,
      report: { id: s.incident_id, label: this.label(s) },
      station: s.station,
      requestedBy: s.requester,
      requestNote: s.request_note,
      changeNote: s.change_note,
      reporter,
      translatorCheck: s.translator_check ? { state: s.translator_check, note: s.translator_note } : null,
      draft:
        s.state === 'signed'
          ? null
          : {
              language: s.draft_language,
              original: s.draft_original,
              english: s.draft_english,
              confidence: s.draft_confidence == null ? null : Number(s.draft_confidence),
              flagged: s.draft_flagged,
              audioId: s.draft_audio_id,
            },
      versions: versions.map((v) => ({
        version: v.version,
        language: v.language,
        languageName: languageName(v.language),
        original: v.original_text,
        english: v.english_text,
        confidence: v.ai_confidence == null ? null : Number(v.ai_confidence),
        flagged: v.flagged_words,
        audioId: v.audio_id,
        signedWith: v.signed_with,
        takenBy: v.taken_by ? takers.get(v.taken_by) ?? null : null,
        present: v.present_name,
        signedAt: v.signed_at,
        seal: short(v.seal),
      })),
      latest: last ? { version: last.version, of: versions.length, seal: short(last.seal), signedAt: last.signed_at } : null,
      access: access.map((a) => ({ action: a.action, by: a.display_name ?? 'Someone with the link', note: a.note, at: a.at })),
    };
  }

  /** "Request more detail": the reporter signs a new version; the old one stays on record. */
  async requestChange(p: Principal, id: string, note: string) {
    const s = await this.staffRow(p, id);
    if (note.trim().length < 5) throw new AppError(422, 'validation_failed', 'Say what is missing, so the reporter knows what to add.', { fields: [{ field: 'note', message: 'Say what is missing.' }] });
    if (s.state !== 'signed') throw new AppError(409, 'not_signed', 'You can ask for more once the reporter has signed.');
    await this.db.tx(async (c) => {
      const last = (await this.versions(id, c)).pop()!;
      await c.query(
        `update statements set state = 'change_requested', change_note = $2, draft_language = $3, draft_original = $4, draft_english = $5, draft_confidence = $6, draft_flagged = $7 where id = $1`,
        [id, note.trim(), last.language, last.original_text, last.english_text, last.ai_confidence, last.flagged_words],
      );
      await c.query(`insert into statement_access (statement_id, actor_id, action, note) values ($1, $2, 'detail_requested', $3)`, [id, p.userId, note.trim()]);
      await notify(c, [s.citizen_id], {
        type: 'statement_change',
        grp: 'reports',
        title: 'More detail asked',
        body: `${s.station ?? 'The station'} asked for more detail in your statement: "${note.trim()}". Your signed version is kept.`,
        link: `/statements/${id}`,
      });
    });
    return { message: 'Sent to the reporter. They sign a new version; the old one stays on record.' };
  }

  /** "If you doubt the translation": ask for a certified human check of the original. */
  async translatorCheck(p: Principal, id: string, note: string) {
    const s = await this.staffRow(p, id);
    if (note.trim().length < 5) throw new AppError(422, 'validation_failed', 'Say what looks wrong, so the translator knows where to look.', { fields: [{ field: 'note', message: 'Say what looks wrong.' }] });
    if (s.translator_check === 'requested') throw new AppError(409, 'already_requested', 'A translator check is already asked for.');
    await this.db.tx(async (c) => {
      await c.query(`update statements set translator_check = 'requested', translator_note = $2 where id = $1`, [id, note.trim()]);
      await c.query(`insert into statement_access (statement_id, actor_id, action, note) values ($1, $2, 'translator_check', $3)`, [id, p.userId, note.trim()]);
      const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
      await notify(c, admins, { type: 'translator_check', grp: 'account', title: 'Translator check asked', body: `${s.number}: ${note.trim()}`, link: '/admin/support' });
    });
    return { message: 'Asked. A certified translator checks the original; their check is added beside the AI text.' };
  }

  async staffPdf(p: Principal, id: string) {
    const s = await this.staffRow(p, id);
    await this.db.query(`insert into statement_access (statement_id, actor_id, action) values ($1, $2, 'downloaded')`, [id, p.userId]);
    await this.audit.write({ actorId: p.userId, action: 'statement.download', entity: 'statement', entityId: id });
    return this.pdf(s);
  }

  // ---------------------------------------------------------------- citizen side

  async mine(p: Principal) {
    const r = await this.db.query(
      `select s.id, s.number, s.state, s.role, s.mode, s.updated_at, s.incident_id, i.type, l.postcode, st.name as station
         from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id left join stations st on st.id = s.station_id
        where s.citizen_id = $1 order by s.state in ('requested', 'change_requested', 'draft') desc, s.updated_at desc`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, number: x.number, state: x.state, stateLabel: STATE_LABEL[x.state], incidentId: x.incident_id, report: `${cap(x.type)}, ${x.postcode ?? 'GPS location'}`, station: x.station, at: x.updated_at, role: x.role, form: statementForm(x.role), mode: x.mode }));
  }

  async own(p: Principal, id: string) {
    return this.full(await this.ownRow(p, id), false);
  }

  /** Saves what they said; makes the AI English record unless they edited it themselves. */
  async saveDraft(p: Principal, id: string, b: { language: string; original: string; english?: string; audioId?: string }) {
    const s = await this.ownRow(p, id);
    if (s.mode === 'in_person') throw new AppError(409, 'in_person', 'This statement is being taken in person by an officer.');
    await this.writeDraft(s, b);
    return this.own(p, id);
  }

  /** Shared by the person writing it and the officer taking it in person. */
  private async writeDraft(s: Row, b: { language: string; original: string; english?: string; audioId?: string }) {
    const id = s.id;
    if (s.state === 'signed') throw new AppError(409, 'signed', 'This version is signed and locked. Use "Add more" to start a new version.');
    const original = b.original.trim();
    if (original.length > STATEMENT_RULES.maxChars) throw new AppError(422, 'validation_failed', 'That is too long for one statement. Split it into versions.');
    let english = b.english?.trim();
    let confidence = s.draft_confidence == null ? null : Number(s.draft_confidence);
    let flagged = s.draft_flagged;
    let language = b.language;
    if (!english || original !== (s.draft_original ?? '') || b.language !== s.draft_language) {
      const ai = (await this.db.query(`select value from platform_settings where key = 'ai'`)).rows[0]?.value;
      if (original && (ai?.paused || ai?.translationPaused)) {
        // AI safety switch: the words are kept and wait for a person to translate them.
        english = english && original === (s.draft_original ?? '') ? english : '';
        confidence = null;
        flagged = [];
      } else if (original) {
        const started = Date.now();
        const t = await this.translator.translate(original, b.language);
        // Usage for "AI and LLM": time, cost estimate and whether it goes to a person for review.
        await this.db.query(`insert into ai_requests (use_case, ms, to_review, cost_kobo, language) values ('translate', $1, $2, $3, $4)`, [
          Date.now() - started,
          t.confidence < 0.8,
          Math.ceil(original.length / 40) * 5,
          t.detected,
        ]);
        english = english && original === (s.draft_original ?? '') ? english : t.english;
        confidence = t.confidence;
        flagged = t.flagged;
        language = t.detected;
      } else {
        english = '';
      }
    }
    await this.db.query(
      `update statements set state = case when state = 'requested' then 'draft' else state end, draft_language = $2, draft_original = $3, draft_english = $4,
              draft_confidence = $5, draft_flagged = $6, draft_audio_id = coalesce($7, draft_audio_id) where id = $1`,
      [id, language, original, english, confidence, flagged, b.audioId ?? null],
    );
  }

  /** Review and sign: PIN (face or fingerprint on the phone unlocks the same PIN check). Sealed and sent. */
  async sign(p: Principal, id: string, b: { pin: string; confirm: boolean; method: 'pin' | 'biometric' }) {
    if (!b.confirm) throw new AppError(422, 'confirm_required', 'Confirm the English says what you meant.', { fields: [{ field: 'confirm', message: 'Confirm it says what you meant.' }] });
    await this.withdrawals.verifyPin(p.userId, b.pin);
    return this.db.tx(async (c) => {
      const s = await this.ownRow(p, id, c, true);
      if (s.mode === 'in_person') throw new AppError(409, 'in_person', 'This statement is confirmed with the code the officer sends you.');
      return this.seal(c, s, p.userId, b.method, null);
    });
  }

  /** Seals the draft as a new version that is never edited, and tells whoever asked. */
  private async seal(c: Queryable, s: Row, actorId: string, signedWith: 'pin' | 'biometric' | 'phone_code', takenBy: string | null) {
    const id = s.id;
    if (s.state === 'signed') throw new AppError(409, 'signed', 'Already signed.');
    if ((s.draft_original ?? '').trim().length < STATEMENT_RULES.minChars) throw new AppError(422, 'too_short', `Say a little more first, at least ${STATEMENT_RULES.minChars} characters.`);
    if (!(s.draft_english ?? '').trim()) throw new AppError(422, 'no_english', 'The English record is empty. Check it before you sign.');
    const version = Number((await c.query(`select coalesce(max(version), 0) + 1 as v from statement_versions where statement_id = $1`, [id])).rows[0].v);
    const signedAt = new Date().toISOString();
    const seal = sealOf({ statementId: id, version, language: s.draft_language!, original: s.draft_original!, english: s.draft_english!, signedAt });
    await c.query(
      `insert into statement_versions (statement_id, version, language, original_text, english_text, ai_confidence, flagged_words, audio_id, signed_with, seal, signed_at, taken_by, role, present_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, version, s.draft_language, s.draft_original, s.draft_english, s.draft_confidence, s.draft_flagged, s.draft_audio_id, signedWith, seal, signedAt, takenBy, s.role, s.present_name],
    );
    await c.query(
      `update statements set state = 'signed', change_note = null, draft_original = null, draft_english = null, draft_audio_id = null, sign_code_hash = null, sign_code_expires_at = null, sign_code_tries = 0 where id = $1`,
      [id],
    );
    const heads = s.station_id
      ? (await c.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role in ('head', 'dispatcher')`, [s.station_id])).rows.map((x) => x.user_id)
      : [];
    await notify(c, [...new Set([s.requested_by, ...heads])].filter((u) => u !== actorId), {
      type: 'statement_signed',
      grp: 'dispatch',
      title: 'Statement signed',
      body: `${s.number}, ${statementForm(s.role).toLowerCase()} for ${this.label(s)}, was signed${version > 1 ? ` (version ${version})` : ''}.`,
      link: `/statements/${id}`,
    });
    await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, $3, 'statement_signed', $4, $5)`, [
      s.incident_id,
      actorId,
      takenBy ? 'officer' : s.role === 'officer' ? 'officer' : 'reporter',
      { label: s.role === 'complainant' ? (version > 1 ? `Statement signed, version ${version}` : 'Statement signed') : version > 1 ? `${statementForm(s.role)} signed, version ${version}` : `${statementForm(s.role)} signed`, statementId: id },
      s.role === 'complainant',
    ]);
    await this.audit.write({ actorId, action: 'statement.sign', entity: 'statement', entityId: id, payload: { version, seal: short(seal), signedWith, takenBy } }, c);
    return { version, seal: short(seal), message: `Sealed and sent to ${s.station ?? 'the station'}.` };
  }

  // ---------------------------------------------------------------- taken in person

  private async takerRow(p: Principal, id: string, c: Queryable = this.db.pool, lock = false) {
    const s = await this.staffRow(p, id, c, lock);
    if (s.mode !== 'in_person') throw new AppError(409, 'not_in_person', 'The person is writing this one themselves.');
    if (s.state === 'signed') throw new AppError(409, 'signed', 'Already signed. Ask for more detail to start a new version.');
    return s;
  }

  /** The officer writes down what the person says, in their language; the English record is made the same way. */
  async takeDraft(p: Principal, id: string, b: { language: string; original: string; english?: string; audioId?: string }) {
    const s = await this.takerRow(p, id);
    await this.writeDraft(s, b);
    await this.db.query(`update statements set taken_by = coalesce(taken_by, $2), sign_code_hash = null, sign_code_expires_at = null where id = $1`, [id, p.userId]);
    return this.full((await this.row(id))!, true);
  }

  /** Suspect: the caution was read to them before anything was taken down. Logged with the time. */
  async caution(p: Principal, id: string) {
    const s = await this.takerRow(p, id);
    if (s.role !== 'suspect') throw new AppError(422, 'not_suspect', 'Only a suspect is cautioned.');
    await this.db.query(`update statements set caution_given_at = coalesce(caution_given_at, now()) where id = $1`, [id]);
    await this.audit.write({ actorId: p.userId, action: 'statement.caution', entity: 'statement', entityId: id });
    return { message: 'Caution recorded with the time.' };
  }

  /** After reading it back: a one-time code goes to the person's phone, so they confirm it, not the officer. */
  async sendCode(p: Principal, id: string) {
    const s = await this.takerRow(p, id);
    if (!s.maker_phone) throw new AppError(422, 'no_phone', 'This person has no phone number on record, so they cannot confirm with a code.');
    if (s.role === 'suspect' && !s.caution_given_at) throw new AppError(422, 'caution_first', 'Read the caution to them and record it first.');
    if ((s.draft_original ?? '').trim().length < STATEMENT_RULES.minChars) throw new AppError(422, 'too_short', `Take down a little more first, at least ${STATEMENT_RULES.minChars} characters.`);
    if (!(s.draft_english ?? '').trim()) throw new AppError(422, 'no_english', 'The English record is empty. Check it with them first.');
    const code = String(randomInt(10 ** (STATEMENT_CODE.digits - 1), 10 ** STATEMENT_CODE.digits));
    await this.db.query(`update statements set sign_code_hash = $2, sign_code_expires_at = now() + make_interval(mins => $3), sign_code_tries = 0 where id = $1`, [
      id,
      createHash('sha256').update(`${id}:${code}`).digest('hex'),
      STATEMENT_CODE.minutes,
    ]);
    try {
      await this.sms.send({ to: s.maker_phone, body: `Your code to confirm statement ${s.number} is ${code}. Only give it to the officer if what they read back is what you said. It expires in ${STATEMENT_CODE.minutes} minutes.`, urgent: true });
    } catch {
      // A code that never arrived must not be usable or block a new one.
      await this.db.query(`update statements set sign_code_hash = null, sign_code_expires_at = null where id = $1`, [id]);
      throw new AppError(503, 'sms_unavailable', 'We could not send the code just now. Try again in a minute.');
    }
    await this.db.query(`insert into statement_access (statement_id, actor_id, action) values ($1, $2, 'code_sent')`, [id, p.userId]);
    return { message: `Code sent to the phone ending ${s.maker_phone.slice(-4)}. Ask them to read it to you.` };
  }

  /** The person reads the code back; the version is sealed as taken in person, with who took it and who was present. */
  async confirmCode(p: Principal, id: string, b: { code: string; confirm: boolean }) {
    if (!b.confirm) throw new AppError(422, 'confirm_required', 'Confirm you read it back to them and they agreed.', { fields: [{ field: 'confirm', message: 'Confirm it was read back.' }] });
    return this.db.tx(async (c) => {
      const s = await this.takerRow(p, id, c, true);
      if (!s.sign_code_hash || !s.sign_code_expires_at || new Date(s.sign_code_expires_at) < new Date()) throw new AppError(409, 'code_expired', 'The code has expired. Send a new one.');
      if (s.sign_code_tries >= STATEMENT_CODE.tries) throw new AppError(429, 'too_many_tries', 'Too many wrong codes. Send a new one.');
      const want = Buffer.from(s.sign_code_hash, 'hex');
      const got = createHash('sha256').update(`${id}:${b.code.trim()}`).digest();
      if (!timingSafeEqual(want, got)) {
        await c.query(`update statements set sign_code_tries = sign_code_tries + 1 where id = $1`, [id]);
        throw new AppError(422, 'wrong_code', 'That code is not right. Check it with them.', { fields: [{ field: 'code', message: 'That code is not right.' }] });
      }
      await c.query(`insert into statement_access (statement_id, actor_id, action) values ($1, $2, 'taken_in_person')`, [id, p.userId]);
      const r = await this.seal(c, s, p.userId, 'phone_code', s.taken_by ?? p.userId);
      await notify(c, [s.citizen_id], {
        type: 'statement_signed_by_you',
        grp: 'reports',
        title: 'Your statement is on record',
        body: `${s.number} was taken down by ${s.taker ?? 'an officer'} and confirmed with your code. You can read and download it.`,
        link: `/statements/${id}`,
      });
      return r;
    });
  }

  // ---------------------------------------------------------------- lists for the station and the agency

  /** Station "Statements" and agency "Statements": every statement on their reports, with filters. */
  async list(p: Principal, scope: { stationId?: string; agencyId?: string }, b: { state?: string; role?: string; q?: string; from?: string; to?: string } & LocationFilter) {
    if (scope.stationId && !(hasRole(p, 'head', scope.stationId) || hasRole(p, 'dispatcher', scope.stationId))) throw new AppError(403, 'forbidden', 'This is for the station head and dispatchers.');
    if (scope.agencyId && !hasRole(p, 'agency_admin', scope.agencyId)) throw new AppError(404, 'not_found', 'Agency not found.');
    const args: unknown[] = [scope.stationId ?? null, scope.agencyId ?? null, b.state ?? null, b.role ?? null, b.q?.trim() || null];
    const where = `${locationWhere(b, args)} and ${dateWhere(b, args, 's.created_at')}`;
    const r = await this.db.query(
      `select s.id, s.number, s.state, s.role, s.mode, s.created_at, s.updated_at, i.id as incident_id, i.type, l.postcode, u.display_name as maker, st.name as station,
              (select max(version) from statement_versions v where v.statement_id = s.id) as versions,
              (select signed_at from statement_versions v where v.statement_id = s.id order by version desc limit 1) as signed_at
         from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id join users u on u.id = s.citizen_id
         left join stations st on st.id = s.station_id
        where ($1::uuid is null or s.station_id = $1 or i.station_id = $1) and ($2::uuid is null or s.agency_id = $2 or i.agency_id = $2)
          and ($3::text is null or s.state = $3) and ($4::text is null or s.role = $4)
          and ($5::text is null or s.number ilike '%' || $5 || '%' or u.display_name ilike '%' || $5 || '%' or l.postcode ilike $5 || '%')
          and ${where}
        order by s.state = 'signed', s.updated_at desc limit 200`,
      args,
    );
    const counts = { waiting: 0, signed: 0, inPerson: 0, changeAsked: 0 };
    for (const x of r.rows) {
      if (x.state === 'signed') counts.signed++;
      else if (x.state === 'change_requested') counts.changeAsked++;
      else counts.waiting++;
      if (x.mode === 'in_person') counts.inPerson++;
    }
    return {
      counts,
      items: r.rows.map((x) => ({
        id: x.id,
        number: x.number,
        state: x.state,
        stateLabel: STATE_LABEL[x.state],
        role: x.role,
        form: statementForm(x.role),
        mode: x.mode,
        maker: x.maker,
        report: { id: x.incident_id, label: `${cap(x.type)}, ${x.postcode ?? 'GPS location'}` },
        station: x.station,
        versions: x.versions ?? 0,
        signedAt: x.signed_at,
        at: x.updated_at,
      })),
    };
  }

  /** "Add more later": a new draft from the last signed version. */
  async amend(p: Principal, id: string) {
    const s = await this.ownRow(p, id);
    if (s.state !== 'signed') return this.own(p, id);
    const last = (await this.versions(id)).pop()!;
    await this.db.query(
      `update statements set state = 'draft', draft_language = $2, draft_original = $3, draft_english = $4, draft_confidence = $5, draft_flagged = $6 where id = $1`,
      [id, last.language, last.original_text, last.english_text, last.ai_confidence, last.flagged_words],
    );
    return this.own(p, id);
  }

  async ownPdf(p: Principal, id: string) {
    return this.pdf(await this.ownRow(p, id));
  }

  /** "Share copy": a view-only link for a lawyer or family, for 7 days. */
  async share(p: Principal, id: string) {
    const s = await this.ownRow(p, id);
    if (!(await this.versions(id)).length) throw new AppError(409, 'not_signed', 'Sign it first; only a signed statement can be shared.');
    const token = randomBytes(24).toString('base64url');
    await this.db.query(`insert into statement_shares (statement_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [
      id,
      createHash('sha256').update(token).digest('hex'),
      STATEMENT_RULES.shareDays,
    ]);
    await this.db.query(`insert into statement_access (statement_id, actor_id, action) values ($1, $2, 'shared')`, [id, p.userId]);
    return { token, path: `/s/${token}`, expiresInDays: STATEMENT_RULES.shareDays, number: s.number };
  }

  async shared(token: string) {
    const sh = (
      await this.db.query(`select statement_id from statement_shares where token_hash = $1 and revoked_at is null and expires_at > now()`, [createHash('sha256').update(token).digest('hex')])
    ).rows[0];
    if (!sh) throw new AppError(404, 'not_found', 'This link has expired or is not valid.');
    const s = (await this.row(sh.statement_id))!;
    await this.db.query(`insert into statement_access (statement_id, action) values ($1, 'shared_opened')`, [s.id]);
    const v = (await this.versions(s.id)).pop()!;
    return {
      number: s.number,
      report: this.label(s),
      station: s.station,
      version: v.version,
      language: languageName(v.language),
      original: v.original_text,
      english: v.english_text,
      signedAt: v.signed_at,
      seal: short(v.seal),
    };
  }

  // ---------------------------------------------------------------- PDF

  private async pdf(s: Row): Promise<{ filename: string; bytes: Buffer }> {
    const versions = await this.versions(s.id);
    if (!versions.length) throw new AppError(409, 'not_signed', 'There is no signed version yet.');
    const v = versions[versions.length - 1];
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Statement ${s.number}`, Author: 'Emergency Response Platform' } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const ink = '#111827';
      const muted = '#6b7280';
      const W = doc.page.width - 96;
      doc.fillColor('#dc2626').fontSize(9).text(statementForm(s.role).toUpperCase(), { characterSpacing: 1 });
      doc.moveDown(0.3).fillColor(ink).fontSize(20).text(`${s.number} · ${this.label(s)}`);
      const how = v.signed_with === 'pin' ? 'PIN' : v.signed_with === 'phone_code' ? 'a code sent to their phone' : 'face or fingerprint';
      doc.fillColor(muted).fontSize(10).text(`${s.maker}, ${statementRoleLabel(s.role).toLowerCase()} · For ${s.station ?? 'the station'} · Version ${v.version} of ${versions.length} · Signed ${when(v.signed_at)} with ${how}`);
      if (v.taken_by) doc.text(`Taken down in person by ${s.taker ?? 'an officer'}${s.taken_at_place ? ` at ${s.taken_at_place}` : ''}${v.present_name ? `, in the presence of ${v.present_name}${s.present_relation ? ` (${s.present_relation})` : ''}` : ''}.`);
      if (s.role === 'suspect') {
        doc.moveDown(0.6).fillColor(ink).fontSize(10).text('Caution', { underline: true });
        doc.fillColor(muted).fontSize(10).text(`${STATEMENT_CAUTION}${s.caution_given_at ? ` Read to them at ${when(s.caution_given_at)}.` : ''}`, { width: W });
      }
      doc.moveDown(1).fillColor(ink).fontSize(12).text('Official English record');
      doc.moveDown(0.3).fontSize(11).text(v.english_text, { width: W });
      doc.moveDown(1).fontSize(12).text(`Original, ${languageName(v.language)}`);
      doc.moveDown(0.3).fillColor(muted).fontSize(11).text(v.original_text, { width: W });
      doc.moveDown(1).fillColor(ink).fontSize(10).text(`Seal code ${short(v.seal)} (full: ${v.seal})`, { width: W });
      if (v.ai_confidence != null) doc.fillColor(muted).fontSize(9).text(`AI translation confidence ${Math.round(Number(v.ai_confidence) * 100)}%. The reporter checked and signed the English text.`, { width: W });
      doc.moveDown(0.5).fillColor(muted).fontSize(8).text('Any later change is a new signed version, never an edit. The seal changes if a single character changes.', { width: W });
      doc.end();
    });
    return { filename: `${s.number}-v${v.version}.pdf`, bytes };
  }
}

