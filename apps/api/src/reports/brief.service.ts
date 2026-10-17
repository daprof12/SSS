// Public issue brief (Public Issues doc §2): a PDF an agency can file or forward,
// and an expiring view-only link for a superior or another office. Neither ever
// names a reporter or carries what they wrote.
import { FIX_CONFIRMATIONS, issueCategory, issueStatus } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db } from '../core/db';
import { AppError } from '../core/http';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const LAGOS = { timeZone: 'Africa/Lagos' } as const;
const day = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { ...LAGOS, day: 'numeric', month: 'short', year: 'numeric' });
const SEVERITY: Record<string, string> = { small: 'Small', dangerous: 'Dangerous', blocking: 'Blocking' };
const LABEL: Record<string, string> = {
  reported: 'First reported',
  joined: 'Someone else reported it',
  assign: 'Agency took it on',
  start: 'Work started',
  mark_fixed: 'Agency marked it fixed',
  not_fixed: 'A reporter said it is not fixed',
  confirm_fixed: 'Confirmed fixed',
};

export type BriefFacts = Awaited<ReturnType<BriefService['facts']>>;

@Injectable()
export class BriefService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
  ) {}

  /** Counts and history only: no reporter ids, no free text from reporters. */
  async facts(caseId: string, agencyId?: string) {
    const k = (
      await this.db.query(
        `select k.*, l.postcode, l.address_text, l.area_label, a.name as agency_name
           from issue_cases k left join locations l on l.id = k.location_id left join agencies a on a.id = k.agency_id
          where k.id = $1 and ($2::uuid is null or k.agency_id = $2)`,
        [caseId, agencyId ?? null],
      )
    ).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Report not found.');
    const reports = (await this.db.query(`select subtype, severity, fixed_vote, created_at from issue_reports where case_id = $1 order by created_at`, [caseId])).rows;
    const events = (await this.db.query(`select kind, payload, at from issue_events where case_id = $1 and kind <> 'more_detail' order by id`, [caseId])).rows;
    const tally = (key: 'severity' | 'subtype') => {
      const m = new Map<string, number>();
      for (const r of reports) if (r[key]) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
      return [...m].map(([value, people]) => ({ value, people })).sort((a, b) => b.people - a.people);
    };
    const perDay = new Map<string, number>();
    for (const r of reports) {
      const d = new Date(r.created_at).toLocaleDateString('en-CA', LAGOS);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const category = issueCategory(k.category)?.label ?? k.category;
    return {
      id: k.id as string,
      agencyId: k.agency_id as string,
      agency: (k.agency_name ?? k.agency_label) as string,
      publicNo: k.public_no as string,
      category,
      status: issueStatus(k.state, k.agency_label).title,
      state: k.state as string,
      place: k.postcode ? `${k.address_text}, ${k.postcode}` : 'Location from GPS',
      area: k.area_label as string | null,
      severity: k.severity as string,
      reports: k.report_count as number,
      people: k.people_count as number,
      firstAt: k.first_at as Date,
      lastAt: k.last_at as Date,
      targetOn: k.target_on as string | null,
      fixNote: k.fix_note as string | null,
      votes: { yes: reports.filter((r) => r.fixed_vote === 'yes').length, no: reports.filter((r) => r.fixed_vote === 'no').length, needed: Math.min(FIX_CONFIRMATIONS, k.people_count) },
      severities: tally('severity'),
      subtypes: tally('subtype'),
      perDay: [...perDay].map(([d, n]) => ({ day: d, reports: n })),
      history: events.map((e) => ({ label: LABEL[e.kind] ?? e.kind, note: (e.payload?.note as string) ?? (e.payload?.by === 'silence' ? 'No one said it was still there' : null), at: e.at as Date })),
    };
  }

  // ---------------------------------------------------------------- PDF

  async agencyPdf(p: Principal, agencyId: string, caseId: string) {
    await this.agencies.requireStaff(p, agencyId);
    const f = await this.facts(caseId, agencyId);
    await this.audit.write({ actorId: p.userId, action: 'issue.brief_download', entity: 'issue_case', entityId: caseId, payload: { agencyId } });
    return { filename: `${f.publicNo}-brief.pdf`, bytes: await render(f, null) };
  }

  // ---------------------------------------------------------------- share links

  async share(p: Principal, agencyId: string, caseId: string, b: { note: string; days: number }) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    await this.facts(caseId, agencyId);
    const token = randomBytes(24).toString('base64url');
    const s = (
      await this.db.query(
        `insert into issue_shares (case_id, agency_id, token_hash, note, created_by, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, expires_at`,
        [caseId, agencyId, hash(token), b.note, p.userId, b.days],
      )
    ).rows[0];
    await this.audit.write({ actorId: p.userId, action: 'issue.share_create', entity: 'issue_case', entityId: caseId, payload: { shareId: s.id, days: b.days } });
    // The token is shown once; only its hash is stored.
    return { id: s.id, path: `/shared/${token}`, token, expiresAt: s.expires_at };
  }

  async shares(p: Principal, agencyId: string, caseId: string) {
    await this.agencies.requireStaff(p, agencyId);
    const r = await this.db.query(
      `select s.id, s.note, s.expires_at, s.revoked_at, s.view_count, s.last_viewed_at, s.created_at, u.display_name as created_by
         from issue_shares s left join users u on u.id = s.created_by where s.case_id = $1 and s.agency_id = $2 order by s.created_at desc`,
      [caseId, agencyId],
    );
    return r.rows.map((s) => ({
      id: s.id,
      note: s.note,
      createdBy: s.created_by,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      views: s.view_count,
      lastViewedAt: s.last_viewed_at,
      status: s.revoked_at ? 'revoked' : new Date(s.expires_at) <= new Date() ? 'expired' : 'active',
    }));
  }

  async revoke(p: Principal, agencyId: string, caseId: string, shareId: string) {
    await this.agencies.requireStaff(p, agencyId, ['agency_admin']);
    const r = await this.db.query(`update issue_shares set revoked_at = now() where id = $1 and case_id = $2 and agency_id = $3 and revoked_at is null returning id`, [shareId, caseId, agencyId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Link not found or already turned off.');
    await this.audit.write({ actorId: p.userId, action: 'issue.share_revoke', entity: 'issue_case', entityId: caseId, payload: { shareId } });
    return { ok: true };
  }

  /** Anyone holding the link, until it expires or is turned off. Every open is counted and logged. */
  async opened(token: string, what: 'view' | 'pdf', ip?: string) {
    const s = (await this.db.query(`select id, case_id, note, expires_at, revoked_at from issue_shares where token_hash = $1`, [hash(token)])).rows[0];
    if (!s) throw new AppError(404, 'not_found', 'This link is not valid.');
    if (s.revoked_at || new Date(s.expires_at) <= new Date()) throw new AppError(410, 'link_expired', 'This link has expired.');
    await this.db.query(`update issue_shares set view_count = view_count + 1, last_viewed_at = now() where id = $1`, [s.id]);
    await this.audit.write({ actorId: null, action: what === 'pdf' ? 'issue.share_pdf' : 'issue.share_view', entity: 'issue_case', entityId: s.case_id, ip, payload: { shareId: s.id } });
    const f = await this.facts(s.case_id);
    const { agencyId: _agencyId, id: _id, ...rest } = f;
    return { share: { note: s.note as string, expiresAt: s.expires_at as Date }, brief: rest };
  }

  async sharedPdf(token: string, ip?: string) {
    const { share, brief } = await this.opened(token, 'pdf', ip);
    return { filename: `${brief.publicNo}-brief.pdf`, bytes: await render(brief, share) };
  }
}

// ------------------------------------------------------------------ rendering

type Renderable = Omit<BriefFacts, 'id' | 'agencyId'>;

function render(f: Renderable, share: { note: string; expiresAt: Date } | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${f.publicNo} brief`, Author: 'Emergency Response Platform' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#111827';
    const muted = '#6b7280';
    const accent = '#dc2626';
    const W = doc.page.width - 96;

    doc.fillColor(accent).fontSize(9).text('PUBLIC ISSUE BRIEF', { characterSpacing: 1 });
    doc.moveDown(0.3).fillColor(ink).fontSize(20).text(`${f.category} · ${f.publicNo}`);
    doc.fillColor(muted).fontSize(10).text(`${f.place}${f.area ? ` · ${f.area}` : ''}`);
    doc.text(`For ${f.agency} · Status: ${f.status} · Prepared ${day(new Date())}`);
    if (share) {
      doc.moveDown(0.6).fillColor(ink).fontSize(10).text(`Note from the agency: ${share.note}`, { width: W });
    }

    // Key numbers
    doc.moveDown(1);
    const y0 = doc.y;
    const boxes: [string, string][] = [
      [String(f.reports), 'reports'],
      [String(f.people), 'people'],
      [SEVERITY[f.severity] ?? f.severity, 'worst reported'],
      [f.targetOn ? day(f.targetOn) : '—', 'target date'],
    ];
    const bw = W / boxes.length;
    boxes.forEach(([v, l], i) => {
      const x = 48 + i * bw;
      doc.roundedRect(x, y0, bw - 8, 52, 6).strokeColor('#e5e7eb').stroke();
      doc.fillColor(ink).fontSize(16).text(v, x + 10, y0 + 9, { width: bw - 28 });
      doc.fillColor(muted).fontSize(8).text(l.toUpperCase(), x + 10, y0 + 33, { width: bw - 28 });
    });
    doc.x = 48;
    doc.y = y0 + 68;
    doc.fillColor(muted).fontSize(9).text(`First reported ${day(f.firstAt)} · Last report ${day(f.lastAt)}`);

    // Reports per day
    heading(doc, 'Reports per day');
    const days = f.perDay.slice(-14);
    const max = Math.max(1, ...days.map((d) => d.reports));
    const ch = 80;
    const cy = doc.y + 12; // room for the tallest bar's count
    const slot = W / Math.max(days.length, 7);
    days.forEach((d, i) => {
      const h = Math.max(2, (d.reports / max) * ch);
      const x = 48 + i * slot;
      doc.rect(x + 4, cy + ch - h, slot - 8, h).fill(accent);
      doc.fillColor(ink).fontSize(7).text(String(d.reports), x, cy + ch - h - 10, { width: slot, align: 'center' });
      doc.fillColor(muted).fontSize(7).text(new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), x, cy + ch + 4, { width: slot, align: 'center' });
    });
    doc.x = 48;
    doc.y = cy + ch + 20;

    // What people report
    heading(doc, 'What people report');
    const list = [...f.subtypes.map((s) => `${s.value}: ${s.people}`), ...f.severities.map((s) => `${SEVERITY[s.value] ?? s.value}: ${s.people}`)];
    doc.fillColor(ink).fontSize(10).text(list.length ? list.join('   ·   ') : 'No details given.', { width: W });
    if (f.state === 'awaiting_check') doc.moveDown(0.3).fillColor(muted).text(`Fix check: ${f.votes.yes} of ${f.votes.needed} reporters said it is fixed.`);
    if (f.fixNote) doc.moveDown(0.3).fillColor(muted).text(`Agency note: ${f.fixNote}`, { width: W });

    // History
    heading(doc, 'History');
    for (const h of f.history) {
      doc.fillColor(muted).fontSize(9).text(new Date(h.at).toLocaleString('en-GB', { ...LAGOS, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), { continued: true, width: W });
      doc.fillColor(ink).text(`   ${h.label}${h.note ? ` — ${h.note}` : ''}`);
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // the footer sits in the margin; never start a new page for it
      doc.fillColor(muted).fontSize(7).text(
        'Confidential. Reporters are not named. For the handling agency and the people it shares this with.' + (share ? ` Link expires ${day(share.expiresAt)}.` : ''),
        48,
        doc.page.height - 40,
        { width: W, align: 'center', lineBreak: false },
      );
    }
    doc.end();
  });
}

function heading(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(1.2).fillColor('#111827').fontSize(12).text(text, 48);
  doc.moveDown(0.4);
}
