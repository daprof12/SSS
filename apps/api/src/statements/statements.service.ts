// B7 Statement (boards "Statement record in any language", "Statement review and sign",
// "Statement signed, download", "Station statement view"). An officer or the station asks; the
// citizen speaks or types in their language; an AI English record is made; the citizen corrects it
// and signs with their PIN; the version is sealed and never edited. A change is a new version.
import { languageName, sideEventAllowedIn, STATEMENT_RULES, type IncidentState } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { TRANSLATE, type TranslateAdapter } from '../adapters/translate';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db, type Queryable } from '../core/db';
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
}

@Injectable()
export class StatementsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(TRANSLATE) private readonly translator: TranslateAdapter,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  private async row(id: string, c: Queryable = this.db.pool, lock = false): Promise<Row | null> {
    return (
      (
        await c.query(
          `select s.*, i.type, l.postcode, st.name as station, ru.display_name as requester
             from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id
             left join stations st on st.id = s.station_id join users ru on ru.id = s.requested_by
            where s.id = $1${lock ? ' for update of s' : ''}`,
          [id],
        )
      ).rows[0] ?? null
    );
  }

  private async versions(id: string, c: Queryable = this.db.pool) {
    return (await c.query(`select * from statement_versions where statement_id = $1 order by version`, [id])).rows;
  }

  /** Officers who are or were on the incident, and the station's head and dispatchers. */
  private async isStaff(p: Principal, incidentId: string, stationId: string | null): Promise<boolean> {
    if (stationId && (hasRole(p, 'head', stationId) || hasRole(p, 'dispatcher', stationId))) return true;
    const on = await this.db.query(`select 1 from incident_units where incident_id = $1 and officer_id = $2 and accepted_at is not null`, [incidentId, p.userId]);
    return !!on.rowCount;
  }

  private async staffRow(p: Principal, id: string) {
    const s = await this.row(id);
    if (!s || !(await this.isStaff(p, s.incident_id, s.station_id))) throw new AppError(404, 'not_found', 'Statement not found.');
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

  /** Step 1: an officer on the incident, or the station, asks the reporter for a statement. */
  async request(p: Principal, incidentId: string, note?: string) {
    const i = (await this.db.query(`select id, state, reporter_id, station_id, type from incidents where id = $1`, [incidentId])).rows[0];
    if (!i || !(await this.isStaff(p, incidentId, i.station_id))) throw new AppError(404, 'not_found', 'This report could not be found.');
    if (!sideEventAllowedIn.statement_requested.includes(i.state as IncidentState)) {
      throw new AppError(409, 'invalid_transition', 'Ask for a statement once a unit is on scene, or after the report is closed.');
    }
    return this.db.tx(async (c) => {
      const existing = (await c.query(`select id, number from statements where incident_id = $1 and citizen_id = $2`, [incidentId, i.reporter_id])).rows[0];
      if (existing) throw new AppError(409, 'already_requested', `A statement was already asked for: ${existing.number}. Open it to ask for more detail.`);
      let number = '';
      for (;;) {
        number = `ST-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from statements where number = $1`, [number])).rowCount) break;
      }
      const s = await c.query(
        `insert into statements (number, incident_id, citizen_id, station_id, requested_by, request_note) values ($1, $2, $3, $4, $5, $6) returning id`,
        [number, incidentId, i.reporter_id, i.station_id, p.userId, note?.trim() || null],
      );
      const station = i.station_id ? (await c.query(`select name from stations where id = $1`, [i.station_id])).rows[0]?.name : null;
      await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, $3, 'statement_requested', $4, true)`, [
        incidentId,
        p.userId,
        hasRole(p, 'head', i.station_id) || hasRole(p, 'dispatcher', i.station_id) ? 'station' : 'officer',
        { label: 'Statement requested', statementId: s.rows[0].id },
      ]);
      await notify(c, [i.reporter_id], {
        type: 'statement_requested',
        grp: 'reports',
        title: 'Statement requested',
        body: `${station ?? 'The station'} asked for your statement about your ${i.type} report. Speak or type it in the language you are most comfortable in.`,
        link: `/statements/${s.rows[0].id}`,
      });
      await this.audit.write({ actorId: p.userId, action: 'statement.request', entity: 'statement', entityId: s.rows[0].id, payload: { incidentId } }, c);
      this.bus.publishIncident({ incidentId, kind: 'statement_requested', at: new Date().toISOString() });
      return { id: s.rows[0].id, number, message: `Asked. The reporter is told; you will be told when it is signed.` };
    });
  }

  async forIncident(p: Principal, incidentId: string) {
    const i = (await this.db.query(`select station_id from incidents where id = $1`, [incidentId])).rows[0];
    if (!i || !(await this.isStaff(p, incidentId, i.station_id))) throw new AppError(404, 'not_found', 'This report could not be found.');
    const r = await this.db.query(
      `select s.id, s.number, s.state, s.updated_at, (select max(version) from statement_versions v where v.statement_id = s.id) as versions,
              (select signed_at from statement_versions v where v.statement_id = s.id order by version desc limit 1) as signed_at
         from statements s where s.incident_id = $1 order by s.created_at`,
      [incidentId],
    );
    return r.rows.map((x) => ({ id: x.id, number: x.number, state: x.state, stateLabel: STATE_LABEL[x.state], versions: x.versions ?? 0, signedAt: x.signed_at }));
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
    const reporter = staff ? (await this.db.query(`select display_name from users where id = $1`, [s.citizen_id])).rows[0].display_name : null;
    return {
      id: s.id,
      number: s.number,
      state: s.state,
      stateLabel: STATE_LABEL[s.state],
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
      `select s.id, s.number, s.state, s.updated_at, s.incident_id, i.type, l.postcode, st.name as station
         from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id left join stations st on st.id = s.station_id
        where s.citizen_id = $1 order by s.state in ('requested', 'change_requested', 'draft') desc, s.updated_at desc`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, number: x.number, state: x.state, stateLabel: STATE_LABEL[x.state], incidentId: x.incident_id, report: `${cap(x.type)}, ${x.postcode ?? 'GPS location'}`, station: x.station, at: x.updated_at }));
  }

  async own(p: Principal, id: string) {
    return this.full(await this.ownRow(p, id), false);
  }

  /** Saves what they said; makes the AI English record unless they edited it themselves. */
  async saveDraft(p: Principal, id: string, b: { language: string; original: string; english?: string; audioId?: string }) {
    const s = await this.ownRow(p, id);
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
    return this.own(p, id);
  }

  /** Review and sign: PIN (face or fingerprint on the phone unlocks the same PIN check). Sealed and sent. */
  async sign(p: Principal, id: string, b: { pin: string; confirm: boolean; method: 'pin' | 'biometric' }) {
    if (!b.confirm) throw new AppError(422, 'confirm_required', 'Confirm the English says what you meant.', { fields: [{ field: 'confirm', message: 'Confirm it says what you meant.' }] });
    await this.withdrawals.verifyPin(p.userId, b.pin);
    return this.db.tx(async (c) => {
      const s = await this.ownRow(p, id, c, true);
      if (s.state === 'signed') throw new AppError(409, 'signed', 'Already signed.');
      if ((s.draft_original ?? '').trim().length < STATEMENT_RULES.minChars) throw new AppError(422, 'too_short', `Say a little more first, at least ${STATEMENT_RULES.minChars} characters.`);
      if (!(s.draft_english ?? '').trim()) throw new AppError(422, 'no_english', 'The English record is empty. Check it before you sign.');
      const version = Number((await c.query(`select coalesce(max(version), 0) + 1 as v from statement_versions where statement_id = $1`, [id])).rows[0].v);
      const signedAt = new Date().toISOString();
      const seal = sealOf({ statementId: id, version, language: s.draft_language!, original: s.draft_original!, english: s.draft_english!, signedAt });
      await c.query(
        `insert into statement_versions (statement_id, version, language, original_text, english_text, ai_confidence, flagged_words, audio_id, signed_with, seal, signed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, version, s.draft_language, s.draft_original, s.draft_english, s.draft_confidence, s.draft_flagged, s.draft_audio_id, b.method, seal, signedAt],
      );
      await c.query(`update statements set state = 'signed', change_note = null, draft_original = null, draft_english = null, draft_audio_id = null where id = $1`, [id]);
      const heads = s.station_id
        ? (await c.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role in ('head', 'dispatcher')`, [s.station_id])).rows.map((x) => x.user_id)
        : [];
      await notify(c, [...new Set([s.requested_by, ...heads])], {
        type: 'statement_signed',
        grp: 'dispatch',
        title: 'Statement signed',
        body: `${s.number} for ${this.label(s)} was signed${version > 1 ? ` (version ${version})` : ''}.`,
        link: `/statements/${id}`,
      });
      await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, 'reporter', 'statement_signed', $3, true)`, [
        s.incident_id,
        p.userId,
        { label: version > 1 ? `Statement signed, version ${version}` : 'Statement signed', statementId: id },
      ]);
      await this.audit.write({ actorId: p.userId, action: 'statement.sign', entity: 'statement', entityId: id, payload: { version, seal: short(seal) } }, c);
      return { version, seal: short(seal), message: `Sealed and sent to ${s.station ?? 'the station'}.` };
    });
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
      doc.fillColor('#dc2626').fontSize(9).text('SIGNED STATEMENT', { characterSpacing: 1 });
      doc.moveDown(0.3).fillColor(ink).fontSize(20).text(`${s.number} · ${this.label(s)}`);
      doc.fillColor(muted).fontSize(10).text(`For ${s.station ?? 'the station'} · Version ${v.version} of ${versions.length} · Signed ${when(v.signed_at)} with ${v.signed_with === 'pin' ? 'PIN' : 'face or fingerprint'}`);
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

