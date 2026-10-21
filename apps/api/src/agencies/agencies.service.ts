// Agency onboarding — UX Gap Analysis §10 stages 1–3, 6, 7 and 11.
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  agencyHandles,
  agencyCopy,
  agencyDirectory,
  agencyDocumentLabels,
  agencyFeatures,
  agencyMachine,
  availableEvents,
  emailEvidence,
  formatNaira,
  namesMatch,
  requiredAgencyDocuments,
  reviewStep,
  type AgencyDocumentKind,
  type AgencyKind,
} from '@erp/domain';
import { POSTCODE, PostcodeUnavailable, type Building, type PostcodeAdapter } from '../adapters/postcode';
import { STORAGE, type StorageAdapter } from '../adapters/storage';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { AgencyLifecycle, stateLabels, type AgencyRow } from './agency.lifecycle';
import { AGENCY_BILLING, AgencyBillingService } from './billing.service';

export interface RegisterInput {
  kind: AgencyKind;
  otherName?: string;
  legalName: string;
  regNo: string;
  headOfficePostcode: string;
  unitType: string;
  officialEmail: string;
  signatoryName: string;
  tin?: string;
}

const CHECKLIST_LABELS: Record<string, string> = {
  stations_and_heads: 'Add stations and heads',
  areas_and_routing: 'Set areas and routing',
  officers_verified: 'Invite officers',
  payout_account: 'Link payout account',
  bounty_pool: 'Bounty rates and fund the pool',
};

@Injectable()
export class AgenciesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly life: AgencyLifecycle,
    @Inject(AgencyBillingService) private readonly billing: AgencyBillingService,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {}

  // ---------------------------------------------------------------- 1 register

  async register(p: Principal, b: RegisterInput) {
    // Contact person: 2FA set-up is forced before the agency exists.
    if (!p.mfa) throw new AppError(403, 'mfa_required', 'Turn on two-step login to continue.');
    let building: Building | null = null;
    let addressWarning: string | undefined;
    try {
      building = await this.postcode.lookup(b.headOfficePostcode);
      if (!building) throw new AppError(422, 'postcode_not_found', agencyCopy.postcodeNotFound, { fields: [{ field: 'headOfficePostcode', message: agencyCopy.postcodeNotFound }] });
    } catch (e) {
      if (!(e instanceof PostcodeUnavailable)) throw e;
      addressWarning = 'The address service is not responding. We saved your application and will confirm the address later.';
    }
    const name = b.kind === 'other' ? b.otherName! : agencyDirectory.find((a) => a.kind === b.kind)!.name;
    const evidence = emailEvidence(b.officialEmail);
    return this.db.tx(async (c) => {
      const locationId = building ? await upsertLocation(c, building) : null;
      const a = (
        await c.query(
          `insert into agencies (name, kind, reg_no, location_id, legal_name, unit_type, official_email, email_evidence, tin, signatory_name, contact_user_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
          [name, b.kind, b.regNo, locationId, b.legalName, b.unitType, b.officialEmail, evidence, b.tin ?? null, b.signatoryName, p.userId],
        )
      ).rows[0];
      await c.query(`insert into user_roles (user_id, role, scope_type, scope_id, granted_by) values ($1, 'agency_admin', 'agency', $2, $1)`, [p.userId, a.id]);
      await c.query(`insert into agency_events (agency_id, event, to_state, actor_id) values ($1, 'register', 'registering', $2)`, [a.id, p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.register', entity: 'agency', entityId: a.id, payload: { kind: b.kind, emailEvidence: evidence } }, c);
      return { id: a.id as string, status: a.status, emailEvidence: evidence, requiredDocuments: requiredAgencyDocuments(b.kind), addressWarning };
    });
  }

  async mine(p: Principal) {
    const r = await this.db.query(
      `select a.id, a.name, a.status, a.kind from agencies a join user_roles r on r.scope_type = 'agency' and r.scope_id = a.id
        where r.user_id = $1 and r.role in ('agency_admin', 'agency_finance') order by a.created_at`,
      [p.userId],
    );
    return r.rows.map((a) => {
      const h = agencyHandles(a.kind);
      return { ...a, statusLabel: stateLabels[a.status as AgencyRow['status']], handles: { tips: h.tips, bounties: h.bounties, issues: h.issues } };
    });
  }

  // ---------------------------------------------------------------- 2 documents

  async addDocument(p: Principal, agencyId: string, d: { kind: AgencyDocumentKind; fileName: string; contentType: string; sizeBytes: number }) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      const a = await this.life.lock(c, agencyId);
      if (!agencyFeatures[a.status].editApplication) {
        throw new AppError(409, 'edit_locked', 'Your application is under review. You can change it if we ask for more information.');
      }
      if (!requiredAgencyDocuments(a.kind as AgencyKind).includes(d.kind)) throw new AppError(422, 'validation_failed', 'This document is not needed for your agency type.');
      const ticket = await this.storage.presignUpload(`agencies/${agencyId}/${d.kind}`, d.contentType);
      await c.query(`update agency_documents set superseded_at = now() where agency_id = $1 and kind = $2 and superseded_at is null`, [agencyId, d.kind]);
      const doc = (
        await c.query(
          `insert into agency_documents (agency_id, kind, storage_key, file_name, content_type, size_bytes, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7) returning id, kind, status`,
          [agencyId, d.kind, ticket.storageKey, d.fileName, d.contentType, d.sizeBytes, p.userId],
        )
      ).rows[0];
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.document_added', entity: 'agency', entityId: agencyId, payload: { kind: d.kind, documentId: doc.id } }, c);
      return { ...doc, label: agencyDocumentLabels[d.kind], upload: ticket };
    });
  }

  async submit(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      const a = await this.life.lock(c, agencyId);
      const have = new Set((await c.query(`select kind from agency_documents where agency_id = $1 and superseded_at is null and status <> 'rejected'`, [agencyId])).rows.map((r) => r.kind));
      const missing = requiredAgencyDocuments(a.kind as AgencyKind).filter((k) => !have.has(k));
      if (missing.length && agencyFeatures[a.status].editApplication) {
        const labels = missing.map((k) => agencyDocumentLabels[k]);
        throw new AppError(422, 'documents_missing', `Add these documents first: ${labels.join(', ')}.`, { fields: missing.map((k) => ({ field: `documents.${k}`, message: 'Required.' })) });
      }
      const { agency, to } = await this.life.transition(c, agencyId, 'submit', 'agency_admin', p.userId, { set: { submitted_at: new Date() } });
      await this.life.notify(c, agency, { type: 'agency_documents_received', grp: 'account', title: 'Documents received', body: 'We are reviewing your application. We will tell you the decision here.' });
      return { status: to };
    });
  }

  /** Status page: timeline, documents, what's needed, and which buttons to show. */
  async status(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId);
    return this.present(agencyId, 'agency_admin');
  }

  private async present(agencyId: string, actor: 'agency_admin' | 'platform_admin') {
    const a = (await this.db.query(`select * from agencies where id = $1`, [agencyId])).rows[0];
    if (!a) throw new AppError(404, 'not_found', 'Agency not found.');
    const docs = (
      await this.db.query(
        `select id, kind, status, review_note, file_name, content_type, size_bytes, created_at from agency_documents where agency_id = $1 and superseded_at is null order by created_at`,
        [agencyId],
      )
    ).rows;
    const timeline = (await this.db.query(`select event, from_state, to_state, comment, at from agency_events where agency_id = $1 order by id`, [agencyId])).rows;
    const overdue = a.status === 'overdue' ? (await this.db.query(`select min(due_on) as d from invoices where agency_id = $1 and state = 'overdue'`, [agencyId])).rows[0].d : null;
    return {
      id: a.id,
      name: a.name,
      legalName: a.legal_name,
      kind: a.kind,
      regNo: a.reg_no,
      unitType: a.unit_type,
      officialEmail: a.official_email,
      emailEvidence: a.email_evidence,
      tin: a.tin,
      signatoryName: a.signatory_name,
      status: a.status,
      statusLabel: stateLabels[a.status as AgencyRow['status']],
      reviewStep: reviewStep(a.status),
      reviewComment: a.status === 'more_info_needed' ? a.review_comment : null,
      decisionReason: a.status === 'rejected' ? a.decision_reason : null,
      appeal: a.status === 'rejected' ? agencyCopy.rejectedAppeal : null,
      banner: a.status === 'overdue' ? { text: agencyCopy.overdueBanner, line: overdue ? agencyCopy.overdueLine(overdue) : null, action: 'Pay now' } : null,
      features: agencyFeatures[a.status as AgencyRow['status']],
      actions: availableEvents(agencyMachine, a.status, actor),
      requiredDocuments: requiredAgencyDocuments(a.kind).map((k) => ({ kind: k, label: agencyDocumentLabels[k], uploaded: docs.some((d) => d.kind === k && d.status !== 'rejected') })),
      documents: docs.map((d) => ({ id: d.id, kind: d.kind, label: agencyDocumentLabels[d.kind as AgencyDocumentKind], status: d.status, note: d.review_note, fileName: d.file_name, contentType: d.content_type, sizeBytes: d.size_bytes, at: d.created_at })),
      timeline: timeline.map((e) => ({ event: e.event, from: e.from_state, to: e.to_state, comment: e.comment, at: e.at })),
      period: a.period_start ? { start: a.period_start, end: a.period_end } : null,
    };
  }

  // ---------------------------------------------------------------- 3 review (platform)

  async adminList(p: Principal, status?: string) {
    this.life.requirePlatformAdmin(p);
    const r = await this.db.query(
      `select id, name, kind, status, email_evidence, submitted_at, created_at from agencies
        where ($1::text is null and status in ('documents_submitted', 'in_review')) or status = $1 order by submitted_at nulls last, created_at`,
      [status ?? null],
    );
    return r.rows.map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, statusLabel: stateLabels[a.status as AgencyRow['status']], emailEvidence: a.email_evidence, submittedAt: a.submitted_at }));
  }

  async adminCard(p: Principal, agencyId: string) {
    this.life.requirePlatformAdmin(p);
    const view = await this.present(agencyId, 'platform_admin');
    return { ...view, approveConfirm: agencyCopy.approveConfirm(view.name) };
  }

  /** Approve / Ask for more (comment shown to the agency) / Reject (reason, final). */
  async decide(
    p: Principal,
    agencyId: string,
    b: { decision: 'approve' | 'ask_more' | 'reject'; comment?: string; reason?: string; documents?: Array<{ id: string; status: 'accepted' | 'rejected'; note?: string }> },
  ) {
    this.life.requirePlatformAdmin(p);
    return this.db.tx(async (c) => {
      let a = await this.life.lock(c, agencyId);
      // Opening the review card moves Submitted → In review.
      if (a.status === 'documents_submitted') a = (await this.life.transition(c, agencyId, 'start_review', 'platform_admin', p.userId)).agency;
      for (const d of b.documents ?? []) {
        const r = await c.query(`update agency_documents set status = $3, review_note = $4, reviewed_by = $5 where id = $1 and agency_id = $2 and superseded_at is null`, [
          d.id,
          agencyId,
          d.status,
          d.note ?? null,
          p.userId,
        ]);
        if (!r.rowCount) throw new AppError(422, 'validation_failed', 'That document is not on this application.');
      }
      if (b.decision === 'approve') {
        const rejected = await c.query(`select 1 from agency_documents where agency_id = $1 and superseded_at is null and status = 'rejected'`, [agencyId]);
        if (rejected.rowCount) throw new AppError(422, 'documents_rejected', 'A document is marked as not accepted. Ask for more instead.');
        await c.query(`update agency_documents set status = 'accepted', reviewed_by = $2 where agency_id = $1 and superseded_at is null and status = 'submitted'`, [agencyId, p.userId]);
        const { agency } = await this.life.transition(c, agencyId, 'approve', 'platform_admin', p.userId, { set: { decided_at: new Date(), review_comment: null } });
        await this.life.notify(c, agency, { type: 'agency_approved', grp: 'account', title: 'Agency approved', body: 'Choose a plan to start setting up.' });
        return { status: agency.status };
      }
      if (b.decision === 'ask_more') {
        const { agency } = await this.life.transition(c, agencyId, 'ask_more', 'platform_admin', p.userId, { comment: b.comment, set: { review_comment: b.comment } });
        await this.life.notify(c, agency, { type: 'agency_more_info', grp: 'account', title: 'More information needed', body: b.comment! });
        return { status: agency.status };
      }
      const { agency } = await this.life.transition(c, agencyId, 'reject', 'platform_admin', p.userId, { comment: b.reason, set: { decision_reason: b.reason, decided_at: new Date() } });
      await this.life.notify(c, agency, { type: 'agency_rejected', grp: 'account', title: 'Application not approved', body: `${b.reason} ${agencyCopy.rejectedAppeal}` });
      return { status: agency.status };
    });
  }

  // ---------------------------------------------------------------- 6 set up

  async addStation(p: Principal, agencyId: string, b: { name: string; postcode: string; headUserId?: string; phone?: string }) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    let building: Building | null;
    try {
      building = await this.postcode.lookup(b.postcode);
    } catch (e) {
      if (e instanceof PostcodeUnavailable) throw new AppError(503, 'postcode_unavailable', 'The address service is not responding. Try again in a few minutes.');
      throw e;
    }
    if (!building) throw new AppError(422, 'postcode_not_found', agencyCopy.postcodeNotFound, { fields: [{ field: 'postcode', message: agencyCopy.postcodeNotFound }] });
    return this.db.tx(async (c) => {
      await this.life.lock(c, agencyId);
      await this.billing.assertNotOnHold(c, agencyId, 'addStations');
      const locationId = await upsertLocation(c, building!);
      const dupe = await c.query(`select 1 from stations where location_id = $1`, [locationId]);
      if (dupe.rowCount) throw new AppError(409, 'duplicate_station', agencyCopy.duplicateStation, { fields: [{ field: 'postcode', message: agencyCopy.duplicateStation }] });
      const st = (
        await c.query(`insert into stations (agency_id, name, location_id, head_user_id, phone) values ($1, $2, $3, $4, $5) returning id, name, status`, [
          agencyId,
          b.name,
          locationId,
          b.headUserId ?? null,
          b.phone ?? null,
        ])
      ).rows[0];
      if (b.headUserId) await this.grant(c, b.headUserId, 'head', 'station', st.id, p.userId);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'station.add', entity: 'station', entityId: st.id, payload: { agencyId, headUserId: b.headUserId ?? null } }, c);
      return st;
    });
  }

  async setHead(p: Principal, agencyId: string, stationId: string, headUserId: string) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      await this.station(c, agencyId, stationId);
      await c.query(`update stations set head_user_id = $2 where id = $1`, [stationId, headUserId]);
      await this.grant(c, headUserId, 'head', 'station', stationId, p.userId);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'station.head_set', entity: 'station', entityId: stationId, payload: { headUserId } }, c);
      await this.activateReadyStations(c, agencyId);
      return { stationId, headUserId };
    });
  }

  async setAreas(p: Principal, agencyId: string, stationId: string, areas: Array<{ level: 'lga' | 'district' | 'area'; areaId: string }>) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      await this.station(c, agencyId, stationId);
      await c.query(`delete from station_areas where station_id = $1`, [stationId]);
      for (const a of areas) await c.query(`insert into station_areas (station_id, level, area_id) values ($1, $2, $3) on conflict do nothing`, [stationId, a.level, a.areaId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'station.areas_set', entity: 'station', entityId: stationId, payload: { areas } }, c);
      await this.activateReadyStations(c, agencyId);
      return { stationId, areas };
    });
  }

  /** Adds an officer to a station. The badge counts as verified once the person's identity is verified (KYC). */
  async addOfficer(p: Principal, agencyId: string, stationId: string, b: { userId: string; badgeNo: string; rank?: string }) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      await this.station(c, agencyId, stationId);
      const kyc = await c.query(`select 1 from kyc_verifications where user_id = $1 and status = 'verified' limit 1`, [b.userId]);
      const badge = kyc.rowCount ? 'verified' : 'pending';
      const r = await c.query(
        `insert into officers (user_id, station_id, badge_no, rank, badge_status) values ($1, $2, $3, $4, $5)
         on conflict (user_id) do nothing returning user_id`,
        [b.userId, stationId, b.badgeNo, b.rank ?? null, badge],
      );
      if (!r.rowCount) throw new AppError(409, 'invite_exists', 'This person is already an officer.');
      await this.grant(c, b.userId, 'officer', 'station', stationId, p.userId);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'officer.add', entity: 'station', entityId: stationId, payload: { userId: b.userId, badgeStatus: badge } }, c);
      await this.activateReadyStations(c, agencyId);
      return { userId: b.userId, badgeStatus: badge, message: badge === 'pending' ? 'Waiting for ID check.' : undefined };
    });
  }

  /** Step 4: payout account must be in the signatory's name; a Paystack subaccount is created for it (mocked). */
  async linkPayoutAccount(p: Principal, agencyId: string, b: { bankCode: string; bankName: string; accountNumber: string; accountName: string }) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      const a = await this.life.lock(c, agencyId);
      if (!['setting_up', 'live', 'overdue'].includes(a.status)) throw new AppError(409, 'not_available', 'You can link a payout account once your onboarding fee is paid.');
      const match = namesMatch(b.accountName, a.signatory_name ?? '');
      if (!match) {
        throw new AppError(422, 'validation_failed', `The account name must match your signatory, ${a.signatory_name}.`, { fields: [{ field: 'accountName', message: 'Name does not match the signatory.' }] });
      }
      await c.query(`update bank_accounts set removed_at = now() where owner_type = 'agency' and owner_id = $1 and removed_at is null`, [agencyId]);
      await c.query(
        `insert into bank_accounts (owner_type, owner_id, bank_code, bank_name, last_four, account_name, name_match, verified_at) values ('agency', $1, $2, $3, $4, $5, true, now())`,
        [agencyId, b.bankCode, b.bankName, b.accountNumber.slice(-4), b.accountName],
      );
      const sub = `ACCT_mock_${randomBytes(6).toString('hex')}`;
      await c.query(`update agencies set paystack_subaccount = $2 where id = $1`, [agencyId, sub]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.payout_account_linked', entity: 'agency', entityId: agencyId, payload: { bankName: b.bankName, lastFour: b.accountNumber.slice(-4) } }, c);
      return { bankName: b.bankName, lastFour: b.accountNumber.slice(-4), nameMatches: true };
    });
  }

  async addInventory(p: Principal, agencyId: string, b: { feeCode: string; quantity: number; stationId?: string }) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      await this.life.lock(c, agencyId);
      await this.billing.assertNotOnHold(c, agencyId, 'addInventory');
      if (!b.feeCode.startsWith('inventory_')) throw new AppError(422, 'validation_failed', 'Add item: choose a type and quantity.');
      const fee = (await c.query(`select label, amount_kobo from agency_fees where code = $1`, [b.feeCode])).rows[0];
      if (!fee) throw new AppError(422, 'validation_failed', 'Add item: choose a type and quantity.');
      if (b.stationId) await this.station(c, agencyId, b.stationId);
      const row = (await c.query(`insert into agency_inventory (agency_id, station_id, fee_code, quantity, added_by) values ($1, $2, $3, $4, $5) returning id`, [agencyId, b.stationId ?? null, b.feeCode, b.quantity, p.userId])).rows[0];
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'inventory.add', entity: 'agency', entityId: agencyId, payload: { feeCode: b.feeCode, quantity: b.quantity } }, c);
      return { id: row.id, feeCode: b.feeCode, quantity: b.quantity, monthly: formatNaira(fee.amount_kobo * b.quantity) };
    });
  }

  async checklist(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId);
    return this.db.tx(async (c) => {
      // Stations can become ready as officers come on duty; re-check whenever the checklist is read.
      await this.activateReadyStations(c, agencyId);
      return this.readChecklist(c, agencyId);
    });
  }

  private async readChecklist(c: Queryable, agencyId: string) {
    const rows = (await c.query(`select * from agency_setup_checklist($1, $2)`, [agencyId, AGENCY_BILLING.minVerifiedOfficersPerStation])).rows;
    const steps = rows.map((r) => ({ step: r.step, code: r.code, label: CHECKLIST_LABELS[r.code], required: r.required, done: r.done, detail: r.detail }));
    const status = (await c.query(`select status from agencies where id = $1`, [agencyId])).rows[0].status;
    const next = steps.find((s) => s.required && !s.done) ?? null;
    return { status, steps, next: next?.code ?? null, canGoLive: status === 'setting_up' && !next };
  }

  // ---------------------------------------------------------------- 7 go live

  async goLive(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    return this.db.tx(async (c) => {
      await this.life.lock(c, agencyId);
      const list = await this.readChecklist(c, agencyId);
      const missing = list.steps.filter((s) => s.required && !s.done);
      if (missing.length && list.status === 'setting_up') {
        throw new AppError(422, 'setup_incomplete', `Finish these steps first: ${missing.map((s) => s.label).join(', ')}.`, { steps: missing.map((s) => s.code) });
      }
      const { agency } = await this.life.transition(c, agencyId, 'go_live', 'agency_admin', p.userId, { set: { live_at: new Date() } });
      const activated = await this.activateReadyStations(c, agencyId);
      await this.life.notify(c, agency, { type: 'agency_live', grp: 'account', title: agencyCopy.live, body: 'Your agency now receives reports in its areas.' });
      return { status: agency.status, message: agencyCopy.live, stationsLive: activated };
    });
  }

  /** "Routing goes live per station when its head + area + ≥1 on-duty officer exist." */
  private async activateReadyStations(c: Queryable, agencyId: string): Promise<string[]> {
    const r = await c.query(
      `update stations s set status = 'active'
         from agencies a
        where s.agency_id = $1 and a.id = s.agency_id and a.status in ('live', 'overdue')
          and s.status in ('draft', 'invite_sent') and s.head_user_id is not null
          and exists (select 1 from station_areas sa where sa.station_id = s.id)
          and exists (select 1 from officers o where o.station_id = s.id and o.on_duty and o.badge_status = 'verified')
        returning s.id, s.name, s.head_user_id`,
      [agencyId],
    );
    for (const st of r.rows) {
      await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'station_live', 'team', 'in_app', 'Station went live', $2, $3)`, [
        st.head_user_id,
        `${st.name} now receives reports.`,
        `/station/${st.id}`,
      ]);
      await this.audit.write({ actorId: null, actorRole: 'system', action: 'station.live', entity: 'station', entityId: st.id, payload: { agencyId } }, c);
    }
    return r.rows.map((s) => s.id);
  }

  // ---------------------------------------------------------------- 11 offboard

  async requestOffboard(p: Principal, agencyId: string, reason: string) {
    await this.life.requireStaff(p, agencyId, ['agency_admin']);
    // The pool is paid back in one payout, so its balance must be final: claims are decided first.
    const claims = (await this.db.query(`select count(*)::int as n from tips where agency_id = $1 and state = 'claim_review'`, [agencyId])).rows[0].n;
    if (claims) throw new AppError(422, 'claims_waiting', `Decide the ${claims === 1 ? 'bounty claim' : `${claims} bounty claims`} waiting before you leave.`);
    return this.db.tx(async (c) => {
      const { agency } = await this.life.transition(c, agencyId, 'request_offboard', 'agency_admin', p.userId, { comment: reason, set: { offboard_reason: reason } });
      // Pay out the bounty pool: one payout for the whole balance, approved by platform staff.
      const pool = (
        await c.query(
          `select w.id, coalesce(b.available_kobo + b.held_kobo, 0)::bigint as kobo from wallets w join wallet_balances b on b.wallet_id = w.id where w.owner_type = 'bounty_pool' and w.owner_id = $1`,
          [agencyId],
        )
      ).rows[0];
      if (pool && pool.kobo > 0) {
        await c.query(`insert into payouts (agency_id, amount_kobo, reason, requested_by, source_wallet_id) values ($1, $2, 'Offboarding: bounty pool balance', $3, $4)`, [agencyId, pool.kobo, p.userId, pool.id]);
      }
      return { status: agency.status, ...(await this.offboardBlockers(c, agencyId)) };
    });
  }

  async offboardStatus(p: Principal, agencyId: string) {
    await this.life.requireStaff(p, agencyId);
    return this.offboardBlockers(this.db.pool, agencyId);
  }

  private async offboardBlockers(c: Queryable, agencyId: string) {
    const invoices = (await c.query(`select id, number, total_kobo, state from invoices where agency_id = $1 and state in ('issued', 'overdue') order by due_on`, [agencyId])).rows;
    const payouts = (await c.query(`select id, amount_kobo, state, failure_reason from payouts where agency_id = $1 and state in ('pending', 'awaiting_second_approval', 'processing', 'failed')`, [agencyId])).rows;
    const officers = (await c.query(`select count(*)::int as n from officers o join stations s on s.id = o.station_id where s.agency_id = $1 and o.on_duty`, [agencyId])).rows[0].n;
    const blockers = [
      ...invoices.map((i) => ({ code: 'unpaid_invoice', message: `Settle invoice ${i.number} (${formatNaira(i.total_kobo)}).`, ref: i.id })),
      ...payouts.map((x) =>
        x.state === 'processing'
          ? { code: 'payout_processing', message: `Payout of ${formatNaira(x.amount_kobo)} is on its way to your bank.`, ref: x.id }
          : x.state === 'failed'
            ? { code: 'payout_failed', message: `Payout of ${formatNaira(x.amount_kobo)} failed: ${x.failure_reason ?? 'the bank did not accept it.'} Check your bank account.`, ref: x.id }
            : { code: 'pending_payout', message: `Payout of ${formatNaira(x.amount_kobo)} is waiting for approval.`, ref: x.id },
      ),
    ];
    return {
      blockers,
      officersOnDuty: officers,
      records: 'Audit and evidence records are kept as policy requires. You can export your records from Settings.',
      canComplete: blockers.length === 0,
    };
  }

  /** Admin: approve, move routing away (stations paused, officers off duty), archive. */
  async completeOffboard(p: Principal, agencyId: string) {
    this.life.requirePlatformAdmin(p);
    return this.db.tx(async (c) => {
      await this.life.lock(c, agencyId);
      const b = await this.offboardBlockers(c, agencyId);
      if (!b.canComplete) throw new AppError(422, 'offboard_blocked', 'Settle these first.', { blockers: b.blockers });
      const paused = await c.query(`update stations set status = 'paused' where agency_id = $1 and status <> 'paused' returning id`, [agencyId]);
      await c.query(`update officers set on_duty = false where station_id in (select id from stations where agency_id = $1)`, [agencyId]);
      const { agency } = await this.life.transition(c, agencyId, 'complete_offboard', 'platform_admin', p.userId, { set: { offboarded_at: new Date() }, payload: { stationsPaused: paused.rowCount } });
      await this.life.notify(c, agency, { type: 'agency_offboarded', grp: 'account', title: 'Agency closed', body: b.records });
      return { status: agency.status, stationsPaused: paused.rowCount };
    });
  }

  // ---------------------------------------------------------------- helpers

  private async station(c: Queryable, agencyId: string, stationId: string) {
    const r = await c.query(`select id from stations where id = $1 and agency_id = $2`, [stationId, agencyId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Station not found.');
  }

  private async grant(c: Queryable, userId: string, role: string, scopeType: string, scopeId: string, by: string) {
    await c.query(`insert into user_roles (user_id, role, scope_type, scope_id, granted_by) values ($1, $2, $3, $4, $5) on conflict do nothing`, [userId, role, scopeType, scopeId, by]);
  }
}

export async function upsertLocation(c: Queryable, b: Building): Promise<string> {
  const r = await c.query(
    `insert into locations (postcode, building_name, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
     values ($1, $2, $3, $4, $5, $6, $7, $8, st_setsrid(st_makepoint($10, $9), 4326)::geography)
     on conflict (postcode) do update set fetched_at = now() returning id`,
    [b.postcode, b.name ?? null, b.address, b.stateId, b.lgaId, b.districtId, b.areaId, b.areaLabel, b.lat, b.lng],
  );
  return r.rows[0].id;
}
