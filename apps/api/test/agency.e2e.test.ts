// End-to-end: agency onboarding and subscription lifecycle (UX Gap Analysis §10, stages 1–11).
// Real NestJS app, real PostgreSQL/PostGIS, mock adapters. The suite resets the schema.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
const t: Record<string, string> = {};
const u: Record<string, string> = {};

const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await fn();
  }
  return v;
}

async function person(key: string, phone: string, name: string, opts: { kyc?: boolean; role?: string } = {}) {
  u[key] = (await db.query(`insert into users (phone, display_name) values ($1, $2) returning id`, [phone, name])).rows[0].id;
  if (opts.kyc) {
    await db.query(
      `insert into kyc_verifications (user_id, provider, provider_ref, id_type, id_masked, status, verified_at) values ($1, 'mock', 'test', 'nin', '•••••••0000', 'verified', now())`,
      [u[key]],
    );
  }
  if (opts.role) await db.query(`insert into user_roles (user_id, role, scope_type) values ($1, $2, 'platform')`, [u[key], opts.role]);
  t[key] = (await http.post('/dev/token').send({ userId: u[key] }).expect(201)).body.token;
}

const doc = (kind: string) => ({ kind, fileName: `${kind}.pdf`, contentType: 'application/pdf', sizeBytes: 120_000 });
const REQUIRED = ['establishment_proof', 'authorisation_letter', 'head_id', 'signatory_letter'];

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '150', PUBLIC_BASE_URL: 'http://erp.test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = await http.post('/dev/seed').expect(201);
  for (const k of ['citizen', 'platformAdmin']) {
    u[k] = seed.body.users[k];
    t[k] = (await http.post('/dev/token').send({ userId: u[k] }).expect(201)).body.token;
  }
  await person('contact', '+2348031110001', 'Grace Okafor');
  t.contactNoMfa = (await http.post('/dev/token').send({ userId: u.contact, mfa: false }).expect(201)).body.token;
  await person('admin2', '+2348031110002', 'Second Admin', { role: 'platform_admin' });
  await person('fireHead', '+2348031110003', 'ACF Tunde Bako', { kyc: true });
  await person('fireOfficer', '+2348031110004', 'FO Amina Yusuf', { kyc: true });
  await person('applicant2', '+2348031110005', 'Other Applicant');
});

afterAll(async () => {
  await app?.close();
});

describe('agency lifecycle: happy path, ask-for-more loop, overdue lock, offboarding', () => {
  let id: string;
  let onboardingInvoice: string;
  let stationId: string;

  it('1 register: forces two-step login and checks the head office postcode', async () => {
    const body = {
      kind: 'fire',
      legalName: 'Federal Fire Service, Lagos Command',
      regNo: 'FFS-LA-001',
      headOfficePostcode: 'GH78J',
      unitType: 'State command',
      officialEmail: 'ops@fedfire.gov.ng',
      signatoryName: 'Grace Okafor',
      tin: '12345678-0001',
    };
    const noMfa = await http.post('/agencies/register').set(as('contactNoMfa')).send(body).expect(403);
    expect(noMfa.body).toMatchObject({ code: 'mfa_required', message: 'Turn on two-step login to continue.' });
    const bad = await http.post('/agencies/register').set(as('contact')).send({ ...body, headOfficePostcode: 'ZZ99Z' }).expect(422);
    expect(bad.body.message).toBe('We could not find that building. Check the postcode or pick it from the list.');

    const r = await http.post('/agencies/register').set(as('contact')).send(body).expect(201);
    expect(r.body).toMatchObject({ status: 'registering', emailEvidence: 'government_domain', requiredDocuments: REQUIRED });
    id = r.body.id;
    const page = (await http.get(`/agencies/${id}`).set(as('contact')).expect(200)).body;
    expect(page).toMatchObject({ name: 'Federal Fire Service', statusLabel: 'Draft', reviewStep: 'draft', actions: ['submit'] });
    await http.get(`/agencies/${id}`).set(as('citizen')).expect(404);
  });

  it('2 documents: saved as a draft, submit needs the full list', async () => {
    const empty = await http.post(`/agencies/${id}/submit`).set(as('contact')).expect(422);
    expect(empty.body.code).toBe('documents_missing');
    for (const k of REQUIRED.slice(0, 3)) {
      const d = await http.post(`/agencies/${id}/documents`).set(as('contact')).send(doc(k)).expect(201);
      expect(d.body.upload).toMatchObject({ method: 'PUT', url: expect.stringContaining('http://erp.test/dev/storage/agencies/') });
    }
    const missing = await http.post(`/agencies/${id}/submit`).set(as('contact')).expect(422);
    expect(missing.body.message).toBe('Add these documents first: Signatory letter.');
    await http.post(`/agencies/${id}/documents`).set(as('contact')).send({ ...doc('signatory_letter'), contentType: 'text/plain' }).expect(400);
    await http.post(`/agencies/${id}/documents`).set(as('contact')).send(doc('signatory_letter')).expect(201);
    expect((await http.post(`/agencies/${id}/submit`).set(as('contact')).expect(201)).body.status).toBe('documents_submitted');
  });

  it('3 under review: edit is locked and only platform staff decide', async () => {
    const locked = await http.post(`/agencies/${id}/documents`).set(as('contact')).send(doc('head_id')).expect(409);
    expect(locked.body.message).toBe('Your application is under review. You can change it if we ask for more information.');
    await http.get('/admin/agencies').set(as('contact')).expect(403);
    await http.post(`/admin/agencies/${id}/decision`).set(as('contact')).send({ decision: 'approve' }).expect(403);
    const waiting = (await http.get('/admin/agencies').set(as('platformAdmin')).expect(200)).body;
    expect(waiting.map((a: any) => a.id)).toContain(id);
    const card = (await http.get(`/admin/agencies/${id}`).set(as('platformAdmin')).expect(200)).body;
    expect(card.approveConfirm).toBe('Approve Federal Fire Service? It can start adding stations.');
    expect(card.documents).toHaveLength(4);
  });

  it('3 ask for more: loops back to documents with the comment shown', async () => {
    const card = (await http.get(`/admin/agencies/${id}`).set(as('platformAdmin'))).body;
    const headId = card.documents.find((d: any) => d.kind === 'head_id').id;
    const noComment = await http.post(`/admin/agencies/${id}/decision`).set(as('platformAdmin')).send({ decision: 'ask_more' }).expect(400);
    expect(noComment.body.fields[0].message).toBe('Tell the agency what to add or change.');
    const comment = "The head's ID has expired. Upload a current one.";
    await http
      .post(`/admin/agencies/${id}/decision`)
      .set(as('platformAdmin'))
      .send({ decision: 'ask_more', comment, documents: [{ id: headId, status: 'rejected', note: 'Expired' }] })
      .expect(201);

    const page = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    expect(page).toMatchObject({ status: 'more_info_needed', statusLabel: 'More information needed', reviewComment: comment, actions: ['submit'] });
    expect(page.requiredDocuments.find((d: any) => d.kind === 'head_id').uploaded).toBe(false);
    expect(page.timeline.map((e: any) => e.event)).toEqual(['register', 'submit', 'start_review', 'ask_more']);
    const note = (await db.query(`select title, body from notifications where user_id = $1 and type = 'agency_more_info'`, [u.contact])).rows[0];
    expect(note).toEqual({ title: 'More information needed', body: comment });

    // Resubmitting without replacing the rejected document is refused.
    expect((await http.post(`/agencies/${id}/submit`).set(as('contact')).expect(422)).body.message).toBe("Add these documents first: Head's ID.");
    await http.post(`/agencies/${id}/documents`).set(as('contact')).send(doc('head_id')).expect(201);
    expect((await http.post(`/agencies/${id}/submit`).set(as('contact')).expect(201)).body.status).toBe('documents_submitted');
  });

  it('3 approve', async () => {
    expect((await http.post(`/admin/agencies/${id}/decision`).set(as('platformAdmin')).send({ decision: 'approve' }).expect(201)).body.status).toBe('approved');
    const page = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    expect(page.documents.every((d: any) => d.status === 'accepted')).toBe(true);
  });

  it('4 choose plan: base + add-ons, onboarding fee + first period with VAT', async () => {
    const cards = (await http.get(`/agencies/${id}/plans`).set(as('contact')).expect(200)).body;
    expect(cards.base[0]).toMatchObject({ code: 'agency_base', includes: { stations: 3 } });
    expect(cards.addons.map((a: any) => a.code).sort()).toEqual(['addon_drone_fire', 'addon_extra_station', 'addon_messaging']);
    await http.post(`/agencies/${id}/plan`).set(as('contact')).send({ addons: { not_a_plan: 1 } }).expect(422);

    const r = await http.post(`/agencies/${id}/plan`).set(as('contact')).send({ addons: { addon_extra_station: 1 } }).expect(201);
    expect(r.body.state).toBe('fee_pending');
    // ₦500,000 onboarding + ₦250,000 base + ₦50,000 extra station = ₦800,000; VAT 7.5%.
    expect(r.body.summary).toMatchObject({ subtotal: '₦800,000.00', vat: '₦60,000.00', total: '₦860,000.00', monthly: '₦322,500.00' });
    expect(r.body.invoice).toMatchObject({ kind: 'onboarding', state: 'issued', totalKobo: 86_000_000 });
    onboardingInvoice = r.body.invoice.id;
    const early = await http.post(`/agencies/${id}/stations`).set(as('contact')).send({ name: 'Station 1 VI', postcode: 'GH78J' }).expect(409);
    expect(early.body.message).toBe('You can add stations once your onboarding fee is paid.');
  });

  it('5 pay by invoice: proforma with PO number and a dedicated account, then finance marks the transfer', async () => {
    const r = await http.post(`/agencies/${id}/invoices/${onboardingInvoice}/pay-by-invoice`).set(as('contact')).send({ poNumber: 'PO/FFS/2026/114' }).expect(201);
    expect(r.body).toMatchObject({ status: 'waiting_for_payment', message: 'Waiting for payment' });
    expect(r.body.proforma).toMatchObject({ title: 'Proforma invoice', poNumber: 'PO/FFS/2026/114', billTo: { tin: '12345678-0001' }, payByInvoice: true });
    expect(r.body.proforma.transferAccount).toMatchObject({ accountNumber: expect.stringMatching(/^\d{10}$/) });
    expect((await http.get(`/agencies/${id}`).set(as('contact'))).body.status).toBe('fee_pending');

    await http.post(`/admin/invoices/${onboardingInvoice}/mark-paid`).set(as('contact')).send({ amountKobo: 1, bankReference: 'NIP-X' }).expect(403);
    const part = await http.post(`/admin/invoices/${onboardingInvoice}/mark-paid`).set(as('platformAdmin')).send({ amountKobo: 40_000_000, bankReference: 'NIP-000111' }).expect(201);
    expect(part.body).toMatchObject({ state: 'issued', balanceKobo: 46_000_000 });
    await http.post(`/admin/invoices/${onboardingInvoice}/mark-paid`).set(as('platformAdmin')).send({ amountKobo: 46_000_000, bankReference: 'NIP-000111' }).expect(409);
    const rest = await http.post(`/admin/invoices/${onboardingInvoice}/mark-paid`).set(as('platformAdmin')).send({ amountKobo: 46_000_000, bankReference: 'NIP-000112' }).expect(201);
    expect(rest.body.state).toBe('paid');
    const page = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    expect(page.status).toBe('setting_up');
    expect(page.period.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('6 set up: one checklist, gated go-live', async () => {
    const before = (await http.get(`/agencies/${id}/setup`).set(as('contact')).expect(200)).body;
    expect(before.steps.map((s: any) => [s.code, s.required, s.done])).toEqual([
      ['stations_and_heads', true, false],
      ['areas_and_routing', true, false],
      ['officers_verified', true, false],
      ['payout_account', true, false],
      ['bounty_pool', false, false],
    ]);
    expect(before).toMatchObject({ next: 'stations_and_heads', canGoLive: false });
    const gate = await http.post(`/agencies/${id}/go-live`).set(as('contact')).expect(422);
    expect(gate.body.message).toBe('Finish these steps first: Add stations and heads, Set areas and routing, Invite officers, Link payout account.');

    const st = await http.post(`/agencies/${id}/stations`).set(as('contact')).send({ name: 'Station 1 VI', postcode: 'GH78J', headUserId: u.fireHead }).expect(201);
    stationId = st.body.id;
    const dupe = await http.post(`/agencies/${id}/stations`).set(as('contact')).send({ name: 'Again', postcode: 'GH78J' }).expect(409);
    expect(dupe.body.message).toBe('A station already uses this building.');
    await http.put(`/agencies/${id}/stations/${stationId}/areas`).set(as('contact')).send({ areas: [{ level: 'area', areaId: 'LA-ETI-03-VIS' }] }).expect(200);
    const off = await http.post(`/agencies/${id}/stations/${stationId}/officers`).set(as('contact')).send({ userId: u.fireOfficer, badgeNo: 'FFS-221' }).expect(201);
    expect(off.body.badgeStatus).toBe('verified');

    const wrong = await http
      .post(`/agencies/${id}/payout-account`)
      .set(as('contact'))
      .send({ bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Somebody Else' })
      .expect(422);
    expect(wrong.body.message).toBe('The account name must match your signatory, Grace Okafor.');
    await http.post(`/agencies/${id}/payout-account`).set(as('contact')).send({ bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'OKAFOR GRACE' }).expect(201);

    const after = (await http.get(`/agencies/${id}/setup`).set(as('contact'))).body;
    expect(after.steps.filter((s: any) => s.required).every((s: any) => s.done)).toBe(true);
    expect(after).toMatchObject({ next: null, canGoLive: true });
  });

  it('7 go live: the station goes live once an officer is on duty', async () => {
    // The officer starts a shift in the officer app.
    await db.query(`update officers set on_duty = true where user_id = $1`, [u.fireOfficer]);
    const r = await http.post(`/agencies/${id}/go-live`).set(as('contact')).expect(201);
    expect(r.body).toMatchObject({ status: 'live', message: 'You are live', stationsLive: [stationId] });
    const note = (await db.query(`select title from notifications where user_id = $1 and type = 'station_live'`, [u.fireHead])).rows[0];
    expect(note.title).toBe('Station went live');
  });

  const fireReport = async (clientRef: string) => {
    const r = await http.post('/incidents').set(as('citizen')).send({ type: 'fire', postcode: 'GH78J', clientRef }).expect(201);
    const officerView = await waitFor(
      () => http.get(`/incidents/${r.body.id}`).set(as('fireOfficer')).then((x) => x.body),
      (v) => v.state === 'offered',
    );
    await http.post(`/incidents/${r.body.id}/cancel`).set(as('citizen')).send({ reason: 'mistake' }).expect(201);
    return officerView;
  };

  it('7 the agency appears in routing', async () => {
    const v = await fireReport('agency-fire-0001');
    expect(v).toMatchObject({ view: 'officer', state: 'offered' });
  });

  let monthly: any;
  let page: any;

  it('8 monthly cycle: invoice issued once per period with stations, inventory and messaging usage', async () => {
    page = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    await db.query(`insert into agency_usage (agency_id, fee_code, units, at) values ($1, 'messaging_sms', 1200, $2::date)`, [id, page.period.start]);
    await http.post(`/agencies/${id}/inventory`).set(as('contact')).send({ feeCode: 'inventory_radio', quantity: 4, stationId }).expect(201);
    await http.post('/admin/billing/generate-invoices').set(as('contact')).send({ asOf: page.period.end }).expect(403);
    const r = await http.post('/admin/billing/generate-invoices').set(as('platformAdmin')).send({ asOf: page.period.end }).expect(201);
    // The seeded demo agency shares the period; look at ours.
    const mine = r.body.issued.filter((i: any) => i.agencyId === id);
    expect(mine).toHaveLength(1);
    const again = await http.post('/admin/billing/generate-invoices').set(as('platformAdmin')).send({ asOf: page.period.end }).expect(201);
    expect(again.body.issued).toHaveLength(0);

    monthly = (await http.get(`/agencies/${id}/invoices/${mine[0].invoiceId}`).set(as('contact')).expect(200)).body;
    expect(monthly).toMatchObject({ kind: 'monthly', state: 'issued', periodStart: page.period.end, dueOn: addDays(page.period.end, 14) });
    expect(monthly.lines.map((l: any) => [l.code, l.quantity])).toEqual([
      ['agency_base', 1],
      ['addon_extra_station', 1],
      ['inventory_radio', 4],
      ['messaging_sms', 1200],
    ]);
    // 250,000 + 50,000 + 4 × 1,500 + 1,200 × 4 = ₦310,800 + 7.5% VAT.
    expect(monthly.totalKobo).toBe(33_411_000);
    const note = (await db.query(`select body from notifications where user_id = $1 and type = 'agency_invoice_issued'`, [u.contact])).rows[0];
    expect(note.body).toBe(`Invoice ${monthly.number} for ₦334,110.00 is due on ${monthly.dueOn}.`);
  });

  it('8 reminders go out 3 days before and on the due day, once each', async () => {
    const r = await http.post('/admin/billing/mark-overdue').set(as('platformAdmin')).send({ asOf: addDays(monthly.dueOn, -3) }).expect(201);
    expect(r.body.reminded).toContain(monthly.id);
    expect(r.body.overdue).toEqual([]);
    const again = await http.post('/admin/billing/mark-overdue').set(as('platformAdmin')).send({ asOf: addDays(monthly.dueOn, -3) }).expect(201);
    expect(again.body.reminded).toEqual([]);
    const due = await http.post('/admin/billing/mark-overdue').set(as('platformAdmin')).send({ asOf: monthly.dueOn }).expect(201);
    expect(due.body.reminded).toContain(monthly.id);
    const titles = (await db.query(`select title from notifications where user_id = $1 and type = 'agency_invoice_due' order by sent_at`, [u.contact])).rows.map((x) => x.title);
    expect(titles).toEqual(['Invoice due soon', 'Invoice due today']);
  });

  it('9 overdue: banner, new stations and equipment on hold', async () => {
    const r = await http.post('/admin/billing/mark-overdue').set(as('platformAdmin')).send({ asOf: addDays(monthly.dueOn, 1) }).expect(201);
    expect(r.body.overdue).toContain(monthly.id);
    const status = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    expect(status).toMatchObject({ status: 'overdue', banner: { text: 'New stations and equipment are on hold until you pay.', line: `Pay by ${monthly.dueOn} to keep adding stations.` } });
    expect(status.features).toMatchObject({ dispatch: true, addStations: false, addInventory: false });

    const st = await http.post(`/agencies/${id}/stations`).set(as('contact')).send({ name: 'Station 2', postcode: 'EF56G' }).expect(402);
    expect(st.body).toMatchObject({ code: 'billing_hold', message: 'New stations and equipment are on hold until you pay.' });
    await http.post(`/agencies/${id}/inventory`).set(as('contact')).send({ feeCode: 'inventory_drone_kit', quantity: 1 }).expect(402);
    await http.post(`/agencies/${id}/plan/change`).set(as('contact')).send({ addons: { addon_extra_station: 2 }, confirm: true }).expect(402);
    const dunning = (await http.get('/admin/invoices').set(as('platformAdmin')).expect(200)).body;
    expect(dunning.find((i: any) => i.id === monthly.id)).toMatchObject({ state: 'overdue', agency: { id } });
    expect(dunning.every((i: any, n: number) => n === 0 || !(i.state === 'overdue' && dunning[n - 1].state !== 'overdue'))).toBe(true);
  });

  it('9 live dispatch keeps working while overdue', async () => {
    const v = await fireReport('agency-fire-0002');
    expect(v).toMatchObject({ view: 'officer', state: 'offered' });
  });

  it('9 paying by card restores the agency the same day', async () => {
    const bad = await http.post(`/agencies/${id}/invoices/${monthly.id}/pay`).set(as('contact')).send({ method: 'card' }).expect(400);
    expect(bad.body.code).toBe('idempotency_key_required');
    const start = await http.post(`/agencies/${id}/invoices/${monthly.id}/pay`).set(as('contact')).set('Idempotency-Key', 'agency-pay-0001').send({ method: 'card' }).expect(201);
    expect(start.body).toMatchObject({ state: 'pending', amount: '₦334,110.00', checkoutUrl: expect.stringContaining('/dev/paystack/checkout/') });
    expect((await http.get(`/agencies/${id}`).set(as('contact'))).body.status).toBe('overdue');

    await http.post(`/dev/paystack/complete/${start.body.reference}?outcome=failed`).expect(201);
    expect((await db.query(`select body from notifications where user_id = $1 and type = 'agency_payment_failed'`, [u.contact])).rows[0].body).toBe(
      'We could not take ₦334,110.00. Adding stations and items is paused.',
    );
    const retry = await http.post(`/agencies/${id}/invoices/${monthly.id}/pay`).set(as('contact')).set('Idempotency-Key', 'agency-pay-0002').send({ method: 'card' }).expect(201);
    await http.post(`/dev/paystack/complete/${retry.body.reference}`).expect(201);
    expect((await http.get(`/agencies/${id}/invoices/${monthly.id}`).set(as('contact'))).body).toMatchObject({ state: 'paid', balanceKobo: 0 });
    expect((await http.get(`/agencies/${id}`).set(as('contact'))).body).toMatchObject({ status: 'live', banner: null });
    await http.post(`/agencies/${id}/inventory`).set(as('contact')).send({ feeCode: 'inventory_drone_kit', quantity: 1 }).expect(201);
  });

  let proration: any;

  it('10 change plan: preview, upgrade now (prorated), downgrade at period end', async () => {
    const preview = await http.post(`/agencies/${id}/plan/change`).set(as('contact')).send({ addons: { addon_extra_station: 2 } }).expect(201);
    expect(preview.body).toMatchObject({ applied: false, currentMonthly: '₦322,500.00', newMonthly: '₦376,250.00', changes: [{ code: 'addon_extra_station', from: 1, to: 2, when: 'now' }] });
    const up = await http.post(`/agencies/${id}/plan/change`).set(as('contact')).send({ addons: { addon_extra_station: 2 }, confirm: true }).expect(201);
    expect(up.body.applied).toBe(true);
    proration = up.body.invoice;
    expect(proration).toMatchObject({ kind: 'proration', state: 'issued' });
    expect(proration.totalKobo).toBeGreaterThan(0);
    expect(proration.totalKobo).toBeLessThanOrEqual(5_375_000);
    expect((await db.query(`select 1 from notifications where user_id = $1 and type = 'agency_addon_activated'`, [u.contact])).rowCount).toBe(1);

    const down = await http.post(`/agencies/${id}/plan/change`).set(as('contact')).send({ addons: { addon_extra_station: 0 }, confirm: true }).expect(201);
    expect(down.body.changes).toEqual([{ code: 'addon_extra_station', from: 2, to: 0, when: 'period_end' }]);
    const cur = (await http.get(`/agencies/${id}`).set(as('contact'))).body;
    expect(down.body.fromNextPeriodOn).toBe(cur.period.end);
    const items = (await db.query(`select code, quantity, ends_on from agency_plan_items where agency_id = $1 and code = 'addon_extra_station' and ends_on is not null order by starts_on desc limit 1`, [id])).rows[0];
    expect(items).toMatchObject({ quantity: 2, ends_on: cur.period.end });
  });

  it('8 waive needs a reason and, above the threshold, a second approver', async () => {
    const big = await http.post('/admin/billing/generate-invoices').set(as('platformAdmin')).send({ asOf: (await http.get(`/agencies/${id}`).set(as('contact'))).body.period.end }).expect(201);
    const inv = big.body.issued.find((i: any) => i.agencyId === id);
    // The downgrade took effect at period end: no extra-station line on the new invoice.
    const detail = (await http.get(`/agencies/${id}/invoices/${inv.invoiceId}`).set(as('contact'))).body;
    expect(detail.lines.map((l: any) => l.code)).not.toContain('addon_extra_station');

    await http.post(`/admin/invoices/${inv.invoiceId}/waive`).set(as('platformAdmin')).send({}).expect(400);
    const first = await http.post(`/admin/invoices/${inv.invoiceId}/waive`).set(as('platformAdmin')).send({ reason: 'Pilot partner, first quarter free' }).expect(201);
    expect(first.body).toMatchObject({ state: 'awaiting_second_approval', approvals: 1 });
    const same = await http.post(`/admin/invoices/${inv.invoiceId}/waive`).set(as('platformAdmin')).send({ reason: 'again' }).expect(409);
    expect(same.body.message).toBe('A second approver must be a different person.');
    const second = await http.post(`/admin/invoices/${inv.invoiceId}/waive`).set(as('admin2')).send({ reason: 'Agreed' }).expect(201);
    expect(second.body).toMatchObject({ state: 'waived', approvals: 2 });
  });

  let payoutId: string;

  it('11 offboard: request, settle invoices and the bounty pool payout (two approvers), then archive', async () => {
    // Bounty pool funded earlier (pool funding flow is not built yet).
    const pool = (await db.query(`insert into wallets (owner_type, owner_id) values ('bounty_pool', $1) returning id`, [id])).rows[0].id;
    const platform = (await db.query(`select id from wallets where owner_type = 'platform'`)).rows[0].id;
    await db.tx((c) =>
      c.query(
        `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo)
         select w, 'fund', amt, 'pool-fund-1', j, 'Pool funded' from (select gen_random_uuid() as j) g,
           (values ($1::uuid, 20000000::bigint), ($2::uuid, -20000000::bigint)) v(w, amt)`,
        [pool, platform],
      ),
    );

    const r = await http.post(`/agencies/${id}/offboard`).set(as('contact')).send({ reason: 'Moving to the state system' }).expect(201);
    expect(r.body.status).toBe('offboarding');
    expect(r.body.blockers.map((b: any) => b.code).sort()).toEqual(['pending_payout', 'unpaid_invoice']);
    payoutId = r.body.blockers.find((b: any) => b.code === 'pending_payout').ref;

    const blocked = await http.post(`/admin/agencies/${id}/offboard/approve`).set(as('platformAdmin')).expect(422);
    expect(blocked.body.code).toBe('offboard_blocked');

    await http.post(`/admin/invoices/${proration.id}/mark-paid`).set(as('platformAdmin')).send({ amountKobo: proration.totalKobo, bankReference: 'NIP-000200' }).expect(201);
    expect((await http.post(`/admin/payouts/${payoutId}/approve`).set(as('platformAdmin')).expect(201)).body).toMatchObject({ state: 'awaiting_second_approval' });
    await http.post(`/admin/payouts/${payoutId}/approve`).set(as('platformAdmin')).expect(409);
    expect((await http.post(`/admin/payouts/${payoutId}/approve`).set(as('admin2')).expect(201)).body).toMatchObject({ state: 'processing', approvals: 2 });
    const bal = (await db.query(`select available_kobo from wallet_balances where wallet_id = $1`, [pool])).rows[0];
    expect(bal.available_kobo).toBe(0);

    // Dispatch continues until the platform approves leaving.
    expect((await fireReport('agency-fire-0003')).state).toBe('offered');

    // Leaving completes only once the pool's transfer has reached the bank.
    expect((await http.post(`/admin/agencies/${id}/offboard/approve`).set(as('platformAdmin')).expect(422)).body.blockers.map((b: any) => b.code)).toEqual(['payout_processing']);
    await http.post(`/dev/paystack/transfer/${payoutId}`).expect(201);

    const done = await http.post(`/admin/agencies/${id}/offboard/approve`).set(as('platformAdmin')).expect(201);
    expect(done.body).toMatchObject({ status: 'offboarded', stationsPaused: 1 });
    expect((await db.query(`select status from stations where id = $1`, [stationId])).rows[0].status).toBe('paused');
  });

  it('wrote an intact audit trail for every money and approval action', async () => {
    expect((await db.query('select audit_verify() as b')).rows[0].b).toBeNull();
    const actions = (await db.query(`select distinct action from audit_log`)).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'agency.register',
        'agency.ask_more',
        'agency.approve',
        'agency.plan_chosen',
        'invoice.pay_by_invoice',
        'invoice.payment_recorded',
        'invoice.transfer_marked',
        'invoice.payment_confirmed',
        'agency.fee_paid',
        'agency.go_live',
        'invoice.mark_overdue',
        'agency.invoice_overdue',
        'agency.payment_received',
        'agency.plan_changed',
        'invoice.waive_requested',
        'invoice.waive_approved',
        'payout.first_approval',
        'payout.approved',
        'agency.complete_offboard',
      ]),
    );
    await expect(db.query('update invoice_payments set note = note')).rejects.toThrow(/append-only/);
    await expect(db.query('delete from agency_events')).rejects.toThrow(/append-only/);
  });
});

describe('agency rejection', () => {
  it('needs a reason, shows it with an appeal contact, and is final', async () => {
    const body = { kind: 'other', legalName: 'Lagos Neighbourhood Safety Corps', regNo: 'LNSC-9', headOfficePostcode: 'EF56G', unitType: 'State agency', officialEmail: 'hq@lnsc.org.ng', signatoryName: 'Other Applicant' };
    const noName = await http.post('/agencies/register').set(as('applicant2')).send(body).expect(400);
    expect(noName.body.fields[0]).toEqual({ field: 'otherName', message: 'Enter the agency name.' });
    const r = await http.post('/agencies/register').set(as('applicant2')).send({ ...body, otherName: 'LNSC' }).expect(201);
    expect(r.body).toMatchObject({ emailEvidence: 'other_domain' });
    expect(r.body.requiredDocuments).toContain('registration_certificate');
    for (const k of r.body.requiredDocuments) await http.post(`/agencies/${r.body.id}/documents`).set(as('applicant2')).send(doc(k)).expect(201);
    await http.post(`/agencies/${r.body.id}/submit`).set(as('applicant2')).expect(201);

    const noReason = await http.post(`/admin/agencies/${r.body.id}/decision`).set(as('platformAdmin')).send({ decision: 'reject' }).expect(400);
    expect(noReason.body.fields[0].message).toBe('A reason is required. It is shown to the agency.');
    await http.post(`/admin/agencies/${r.body.id}/decision`).set(as('platformAdmin')).send({ decision: 'reject', reason: 'Not a response agency under the PRD.' }).expect(201);
    const page = (await http.get(`/agencies/${r.body.id}`).set(as('applicant2'))).body;
    expect(page).toMatchObject({ status: 'rejected', decisionReason: 'Not a response agency under the PRD.', appeal: expect.stringContaining('appeal'), actions: [] });
    expect((await http.post(`/agencies/${r.body.id}/submit`).set(as('applicant2')).expect(409)).body.code).toBe('terminal_state');
  });
});
