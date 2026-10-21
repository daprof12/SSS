// Station, agency and admin dashboards: the numbers move with real reports, and the actions work.
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
let users: Record<string, string>;
let stationId: string;
let agencyId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ref = () => `db-${Date.now()}-${++n}`;
const view = async (who: string, id: string) => (await http.get(`/incidents/${id}`).set(as(who))).body;

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
  agencyId = seed.agencyId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [stationId, u, lng, lat]);
  }
});
afterAll(async () => {
  await app?.close();
});

describe('station dashboard', () => {
  let incident = '';
  let lead = '';
  it('summary, queue and map follow a live report', async () => {
    incident = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    for (let i = 0; i < 100 && (await view('citizen', incident)).state !== 'offered'; i++) await sleep(50);
    for (const w of ['officer', 'officer2']) if ((await view(w, incident)).view === 'officer') lead = w;
    await http.post(`/incidents/${incident}/actions`).set(as(lead)).send({ event: 'accept' }).expect(201);
    const s = (await http.get('/me/station/summary').set(as('head')).expect(200)).body;
    expect(s.station.name).toBe('Station 4 Ikeja');
    expect(s.stats).toMatchObject({ open: 1, onDuty: 2, available: 1, acceptsToday: 1 });
    expect(s.stats.medianAcceptS).toBeGreaterThanOrEqual(0);
    const m = (await http.get('/me/station/map').set(as('head')).expect(200)).body;
    expect(m.incidents[0]).toMatchObject({ id: incident, label: 'Robbery, AB12C', state: 'accepted' });
    expect(m.units.find((u: any) => u.id === users[lead]).status).toBe('accepted');
    expect(m.devices.length).toBeGreaterThan(0);
    await http.get('/me/station/summary').set(as('citizen')).expect(403);
  });

  it('sends a second unit, which the incident detail shows', async () => {
    const other = lead === 'officer' ? 'officer2' : 'officer';
    await http.post(`/incidents/${incident}/reinforce`).set(as('head')).send({ officerId: users[lead] }).expect(422);
    expect((await http.post(`/incidents/${incident}/reinforce`).set(as('head')).send({ officerId: users[other] }).expect(201)).body.message).toMatch(/is on the way as the second unit\.$/);
    const x = (await http.get(`/incidents/${incident}/station-detail`).set(as('head')).expect(200)).body;
    expect(x.units.map((u: any) => [u.role, u.state])).toEqual([
      ['primary', 'accepted'],
      ['reinforcement', 'accepted'],
    ]);
    expect(x.reports[0]).toMatchObject({ role: 'first', who: 'Ada Obi' });
    const note = (await http.get('/me/notifications').set(as(other))).body.items.find((n: any) => n.type === 'reinforcement');
    expect(note.body).toBe('Go to Robbery at AB12C. You are the second unit.');
  });

  it('officers board, and on/off duty from the dashboard', async () => {
    const tm = (await http.get('/me/station/team').set(as('head')).expect(200)).body;
    expect(tm.stats).toMatchObject({ onDuty: 2, busy: 2, available: 0 });
    const busy = tm.officers.find((o: any) => o.id === users.officer);
    expect(busy).toMatchObject({ status: 'busy', doingNow: 'Robbery, AB12C' });
    expect((await http.post(`/me/station/officers/${users.officer}/duty`).set(as('head')).send({ on: false }).expect(409)).body.message).toMatch(/is on a report\. Reassign it first\.$/);
  });

  it('reports page counts closed reports, ratings and false-alarm share', async () => {
    for (const ev of ['start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${incident}/actions`).set(as(lead)).send({ event: ev }).expect(201);
    await http.post(`/incidents/${incident}/actions`).set(as(lead)).send({ event: 'close_valid', outcomeCode: 'arrest' }).expect(201);
    await http.post(`/incidents/${incident}/rating`).set(as('citizen')).send({ stars: 5 }).expect(201);
    const r = (await http.get('/me/station/reports?days=30').set(as('head')).expect(200)).body;
    expect(r.stats).toMatchObject({ reports: 1, resolvedPct: 100, falseAlarmPct: 0, rating: 5 });
    expect(r.byType).toEqual([{ type: 'robbery', label: 'Robbery', n: 1 }]);
    expect(r.ratings[0]).toEqual({ stars: 5, n: 1 });
    expect(r.recent[0]).toMatchObject({ id: incident, outcome: 'Resolved', stars: 5 });
    await http.get('/me/station/reports?days=12').set(as('head')).expect(400);
  });

  it('roster: set shifts, see gaps against the minimum, publish to officers', async () => {
    const r0 = (await http.get('/me/station/roster').set(as('head')).expect(200)).body;
    expect(r0.days).toHaveLength(7);
    const mon = r0.days[0].date;
    await http.put('/me/station/roster').set(as('head')).send({ officerId: users.officer, date: mon, kind: 'day' }).expect(200);
    await http.put('/me/station/roster').set(as('head')).send({ officerId: users.officer2, date: mon, kind: 'night' }).expect(200);
    const r = (await http.get(`/me/station/roster?week=${mon}`).set(as('head'))).body;
    expect(r.officers.find((o: any) => o.id === users.officer).days[0]).toBe('day');
    expect(r.perDay[0]).toEqual({ day: 1, night: 1 });
    expect(r.gaps.find((g: any) => g.day === 'Mon')).toBeUndefined();
    expect(r.gaps.some((g: any) => g.day === 'Tue')).toBe(true);
    await http.post('/me/station/roster/publish').set(as('head')).send({ week: mon }).expect(201);
    expect((await http.get('/me/notifications').set(as('officer'))).body.items.some((x: any) => x.type === 'roster_published')).toBe(true);
  });

  it('messages: send to on-duty officers, they read and confirm, the station sees it', async () => {
    expect((await http.post('/me/station/messages').set(as('head')).send({ audience: 'on_duty', title: 'Road closed', body: '' }).expect(400)).body.fields[0].message).toBe('Write a message before sending.');
    const s = (await http.post('/me/station/messages').set(as('head')).send({ audience: 'on_duty', title: 'Road closed', body: 'Ring Road is closed tonight.', needsConfirm: true }).expect(201)).body;
    expect(s.message).toBe('Sent to 2 officers.');
    const note = (await http.get('/me/notifications').set(as('officer'))).body.items.find((x: any) => x.type === 'station_message');
    expect(note.link ?? note.deepLink).toBe(`/messages/${s.id}`);
    await http.get(`/me/messages/${s.id}`).set(as('officer')).expect(200);
    await http.post(`/me/messages/${s.id}/confirm`).set(as('officer')).expect(200);
    await http.get(`/me/messages/${s.id}`).set(as('citizen')).expect(404);
    const m = (await http.get('/me/station/messages').set(as('head'))).body.recent[0];
    expect(m).toMatchObject({ total: 2, read: 1, confirmed: 1 });
    expect((await http.post(`/me/station/messages/${s.id}/resend`).set(as('head')).expect(201)).body.message).toBe('Sent again to 1 who have not read it.');
  });

  it('settings: the head changes the accept window within limits', async () => {
    expect((await http.patch('/me/station/settings').set(as('head')).send({ acceptWindowSeconds: 5 }).expect(422)).body.message).toBe('Give officers between 10 and 120 seconds to accept.');
    await http.patch('/me/station/settings').set(as('head')).send({ acceptWindowSeconds: 40, alerts: { dailySummary: true } }).expect(200);
    const s = (await http.get('/me/station/settings').set(as('head'))).body;
    expect(s).toMatchObject({ canEdit: true, acceptWindowSeconds: 40 });
    expect(s.settings.alerts).toMatchObject({ dailySummary: true, tamper: true });
  });
});

describe('agency and admin dashboards', () => {
  it('agency overview and stations', async () => {
    const o = (await http.get(`/agencies/${agencyId}/overview`).set(as('agencyAdmin')).expect(200)).body;
    expect(o.stats).toMatchObject({ rating: 5 });
    expect(o.stations[0]).toMatchObject({ name: 'Station 4 Ikeja', onDuty: 2 });
    expect(o.week).toHaveLength(7);
    await http.get(`/agencies/${agencyId}/overview`).set(as('citizen')).expect(404);
    expect((await http.get(`/agencies/${agencyId}/station-list`).set(as('agencyAdmin')).expect(200)).body[0].officers).toBeGreaterThanOrEqual(2);
  });

  it('admin overview, users, subscriptions, live map', async () => {
    await http.get('/admin/overview').set(as('head')).expect(403);
    const o = (await http.get('/admin/overview').set(as('platformAdmin')).expect(200)).body;
    expect(o.stats.activeSubscriptions).toBe(1);
    expect(o.devices.total).toBe(4);
    expect(o.attention.map((a: any) => a.key)).toEqual(['tamper', 'escalated', 'appeals', 'agencies', 'payments']);
    const u = (await http.get('/admin/users?role=officers').set(as('platformAdmin')).expect(200)).body;
    expect(u.map((x: any) => x.role)).toEqual(expect.arrayContaining(['Officer']));
    expect((await http.get('/admin/users?q=Ada').set(as('platformAdmin'))).body[0]).toMatchObject({ name: 'Ada Obi', role: 'Household owner', postcode: 'AB12C' });
    const subs = (await http.get('/admin/subscriptions?state=active').set(as('platformAdmin')).expect(200)).body;
    expect(subs.items[0]).toMatchObject({ owner: 'Ada Obi', plan: 'Household', cameras: 2, lights: 2 });
    expect((await http.post(`/admin/subscriptions/${subs.items[0].id}`).set(as('platformAdmin')).send({ action: 'pause' }).expect(422)).body.message).toBe('Give a reason; it is logged.');
    await http.post(`/admin/subscriptions/${subs.items[0].id}`).set(as('platformAdmin')).send({ action: 'remind' }).expect(200);
    expect((await http.get('/admin/live').set(as('platformAdmin')).expect(200)).body.units.length).toBeGreaterThan(0);
  });

  it('KYC queue: approve a manual review', async () => {
    await db.query(`insert into kyc_verifications (user_id, provider, provider_ref, id_type, id_masked, selfie_match, liveness, status) values ($1, 'mock', 'x', 'nin', '•••••••2222', 0.81, true, 'manual_review')`, [users.neighbour]);
    const q = (await http.get('/admin/kyc').set(as('platformAdmin')).expect(200)).body;
    const k = q.find((x: any) => x.name === 'Chidi Neighbour');
    expect(k).toMatchObject({ idType: 'NIN', faceMatchPct: 81, status: 'manual_review' });
    expect((await http.post(`/admin/kyc/${k.id}`).set(as('platformAdmin')).send({ decision: 'reject' }).expect(422)).body.message).toBe('Give a reason the person will read.');
    await http.post(`/admin/kyc/${k.id}`).set(as('platformAdmin')).send({ decision: 'approve' }).expect(200);
    expect((await http.get('/me').set(as('neighbour'))).body.kyc.status).toBe('verified');
  });
});
