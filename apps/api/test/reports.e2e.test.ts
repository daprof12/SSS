// Tips → bounty (B2) and public issues (B3).
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { createApp } from '../src/main';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
let seed: { users: Record<string, string>; naptipId: string; fermaId: string };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let n = 0;
const ref = () => `ref-${Date.now()}-${++n}`;
const DESC = 'Girls are kept in a house on Allen and moved at night by a white bus.';

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  seed = (await http.post('/dev/seed').expect(201)).body;
  for (const [k, id] of Object.entries(seed.users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

const tip = (who: string, body: Record<string, unknown> = {}) =>
  http.post('/tips').set(as(who)).send({ category: 'human_trafficking', description: DESC, anonymous: true, clientRef: ref(), postcode: 'CD34E', ...body });
const act = (tipId: string, body: Record<string, unknown>) => http.post(`/agencies/${seed.naptipId}/tips/${tipId}/actions`).set(as('agencyAdmin')).send(body);

describe('tips', () => {
  it('shows who receives each category and the bounty range', async () => {
    const cats = (await http.get('/tips/categories').set(as('citizen')).expect(200)).body;
    expect(cats.find((c: any) => c.code === 'human_trafficking')).toMatchObject({ agencyLabel: 'NAPTIP (demo)', joined: true, bounty: { text: '₦50,000 to ₦500,000' } });
    expect(cats.find((c: any) => c.code === 'fraud')).toMatchObject({ agencyLabel: 'EFCC, ICPC', joined: false, bounty: null });
    expect(cats.find((c: any) => c.code === 'road_accident').emergencyHint).toMatch(/SOS/);
  });

  it('validates with the States doc copy', async () => {
    expect((await tip('citizen', { description: 'too short' }).expect(422)).body.message).toBe('Add a little more so the agency can act.');
    expect((await tip('citizen', { category: 'unicorns' }).expect(422)).body.message).toBe('Choose what you are reporting.');
  });

  it('routes to the agency, hides the tipper, and is idempotent', async () => {
    const clientRef = ref();
    const r = (await tip('citizen', { clientRef }).expect(201)).body;
    expect(r).toMatchObject({ publicNo: expect.stringMatching(/^T-\d{6}$/), routedTo: 'NAPTIP (demo)' });
    expect((await tip('citizen', { clientRef }).expect(201)).body).toMatchObject({ id: r.id, duplicate: true });

    const d = (await http.get(`/tips/${r.id}`).set(as('citizen')).expect(200)).body;
    expect(d.status.chip).toBe('With NAPTIP (demo)');
    expect(d.steps.map((s: any) => [s.label, s.done])).toEqual([
      ['Received', true],
      ['Sent to NAPTIP (demo)', true],
      ['Verified result', false],
      ['Bounty paid', false],
    ]);
    const queue = (await http.get(`/agencies/${seed.naptipId}/tips`).set(as('agencyAdmin')).expect(200)).body;
    const row = queue.find((x: any) => x.id === r.id);
    expect(row.tipper).toBe(`Anonymous tipper ${r.publicNo}`);
    expect(JSON.stringify(row)).not.toContain('Ada');
    await http.get(`/tips/${r.id}`).set(as('neighbour')).expect(404);
    await http.get(`/agencies/${seed.naptipId}/tips`).set(as('citizen')).expect(404);
  });

  it('asks for more, takes the answer, records a result and pays the bounty into a held wallet', async () => {
    const r = (await tip('citizen').expect(201)).body;
    expect((await act(r.id, { event: 'ask_more' }).expect(422)).body.message).toBe('Say what you need from the tipper.');
    await act(r.id, { event: 'ask_more', comment: 'Which house number?' }).expect(201);
    expect((await http.get(`/tips/${r.id}`).set(as('citizen'))).body.status.chip).toBe('Needs more info');
    await http.post(`/tips/${r.id}/info`).set(as('citizen')).send({ text: 'House 14, blue gate' }).expect(201);
    expect((await http.get(`/tips/${r.id}`).set(as('citizen'))).body.state).toBe('in_queue');

    await act(r.id, { event: 'outcome_recorded', outcome: 'rescue', severity: 'high' }).expect(201);
    expect((await act(r.id, { event: 'approve', amountKobo: 60000000 }).expect(422)).body.message).toBe('This is above the cap of ₦500,000.00.');
    const before = (await http.get('/me/wallet').set(as('citizen'))).body.heldKobo;
    await act(r.id, { event: 'approve' }).expect(201);
    const w = (await http.get('/me/wallet').set(as('citizen'))).body;
    expect(w.heldKobo - before).toBe(50000000);
    const d = (await http.get(`/tips/${r.id}`).set(as('citizen'))).body;
    expect(d).toMatchObject({ state: 'approved_held', bounty: { amount: '₦500,000.00' }, canWithdraw: false });
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'bounty_approved');
    expect(note.body).toBe('₦500,000.00 was added to your wallet. It can be withdrawn in 7 days.');
    await http.post(`/tips/${r.id}/withdraw`).set(as('citizen')).expect(409);
  });

  it('refuses a bounty to the agency’s own staff and when the pool is short', async () => {
    const own = (await tip('agencyAdmin').expect(201)).body;
    await act(own.id, { event: 'outcome_recorded', outcome: 'arrest' }).expect(201);
    expect((await act(own.id, { event: 'approve' }).expect(409)).body.message).toBe('Staff of this agency cannot claim its bounties.');

    const r = (await tip('neighbour').expect(201)).body;
    await act(r.id, { event: 'outcome_recorded', outcome: 'arrest' }).expect(201);
    await db.query(`update bounty_rates set cap_kobo = 999999999999 where agency_id = $1`, [seed.naptipId]);
    expect((await act(r.id, { event: 'approve', amountKobo: 900000000 }).expect(409)).body.message).toMatch(/^Your pool has ₦[\d,.]+\. Add funds before approving\.$/);
  });

  it('lets the tipper withdraw, and lowers trust for a false tip', async () => {
    const a = (await tip('neighbour').expect(201)).body;
    await http.post(`/tips/${a.id}/withdraw`).set(as('neighbour')).expect(201);
    expect((await http.get(`/tips/${a.id}`).set(as('neighbour'))).body.status.title).toBe('You withdrew this tip');

    const b = (await tip('neighbour').expect(201)).body;
    const trust = async () => (await db.query(`select score from trust_scores where user_id = $1`, [seed.users.neighbour])).rows[0].score;
    const s0 = await trust();
    await act(b.id, { event: 'mark_false', reason: 'Address does not exist' }).expect(201);
    expect(await trust()).toBe(s0 - 10);
    const mine = (await http.get('/me/tips?tab=declined').set(as('neighbour'))).body;
    expect(mine.map((x: any) => x.state)).toEqual(expect.arrayContaining(['withdrawn', 'found_false']));
  });
});

const issue = (who: string, body: Record<string, unknown> = {}) =>
  http.post('/issues').set(as(who)).send({ category: 'road', subtype: 'Pothole', severity: 'dangerous', description: 'Deep pothole by the bus stop', clientRef: ref(), postcode: 'GH78J', ...body });
const iact = (caseId: string, body: Record<string, unknown>) => http.post(`/agencies/${seed.fermaId}/issues/${caseId}/actions`).set(as('agencyAdmin')).send(body);

describe('public issues', () => {
  let caseId: string;

  it('lists categories with the receiving agency', async () => {
    const cats = (await http.get('/issues/categories').set(as('citizen')).expect(200)).body;
    expect(cats.find((c: any) => c.code === 'road')).toMatchObject({ agencyLabel: 'FERMA (demo)', joined: true, subtypes: expect.arrayContaining(['Pothole']) });
    expect(cats.find((c: any) => c.code === 'one_chance').urgent).toBe(true);
  });

  it('needs a few words and a place', async () => {
    expect((await issue('citizen', { description: 'hole' }).expect(422)).body.message).toBe('Photo or a few words needed so the team can find it.');
    expect((await issue('citizen', { postcode: undefined }).expect(422)).body.message).toBe('Add where it is: your location or a postcode.');
  });

  it('merges nearby reports into one case and counts people once', async () => {
    const a = (await issue('citizen').expect(201)).body;
    caseId = a.id;
    expect(a).toMatchObject({ publicNo: expect.stringMatching(/^P-\d{6}$/), reports: 1, people: 1, joined: false });
    const b = (await issue('neighbour', { severity: 'blocking' }).expect(201)).body;
    expect(b).toMatchObject({ id: caseId, reports: 2, people: 2, joined: true });
    const again = (await issue('citizen').expect(201)).body;
    expect(again).toMatchObject({ id: caseId, reports: 2, already: true });
    expect((await http.get('/issues/nearby?category=road&postcode=GH78J').set(as('officer'))).body).toMatchObject({ caseId, reports: 2, people: 2 });
    expect((await http.get(`/issues/${caseId}`).set(as('citizen'))).body.severity).toBe('blocking');
    await http.get(`/issues/${caseId}`).set(as('officer')).expect(404);
  });

  it('runs assign → work → fixed, reopens on a "no", closes on enough "yes"', async () => {
    await iact(caseId, { event: 'assign', targetOn: '2026-11-30' }).expect(201);
    await iact(caseId, { event: 'start' }).expect(201);
    expect((await iact(caseId, { event: 'mark_fixed' }).expect(422)).body.message).toBe('Say what was done. A photo comes next.');
    await iact(caseId, { event: 'mark_fixed', note: 'Patched with asphalt' }).expect(201);

    const d = (await http.get(`/issues/${caseId}`).set(as('citizen'))).body;
    expect(d).toMatchObject({ state: 'awaiting_check', canVote: true, status: { title: 'Is it fixed?' }, fixNote: 'Patched with asphalt' });
    const ask = (await http.get('/me/notifications').set(as('neighbour'))).body.items.find((x: any) => x.type === 'issue_mark_fixed');
    expect(ask.body).toBe('FERMA (demo) says the bad road or pothole is fixed. Is it?');

    expect((await http.post(`/issues/${caseId}/vote`).set(as('citizen')).send({ vote: 'yes' }).expect(201)).body).toMatchObject({ state: 'awaiting_check', yes: 1, needed: 2 });
    expect((await http.post(`/issues/${caseId}/vote`).set(as('neighbour')).send({ vote: 'no' }).expect(201)).body.state).toBe('reopened');

    await iact(caseId, { event: 'start' }).expect(201);
    await iact(caseId, { event: 'mark_fixed', note: 'Resurfaced properly' }).expect(201);
    await http.post(`/issues/${caseId}/vote`).set(as('citizen')).send({ vote: 'yes' }).expect(201);
    expect((await http.post(`/issues/${caseId}/vote`).set(as('neighbour')).send({ vote: 'yes' }).expect(201)).body.state).toBe('fixed');
    await http.post(`/issues/${caseId}/vote`).set(as('neighbour')).send({ vote: 'yes' }).expect(409);
    const mine = (await http.get('/me/issues').set(as('citizen'))).body.find((x: any) => x.id === caseId);
    expect(mine.status.title).toBe('Fixed');
  });
});
