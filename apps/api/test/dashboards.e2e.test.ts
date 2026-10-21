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
    const subs = (await http.get('/admin/subscriptions?status=active').set(as('platformAdmin')).expect(200)).body;
    expect(subs.items[0]).toMatchObject({ owner: 'Ada Obi', plan: 'Household', cameras: 2, lights: 2 });
    expect((await http.post(`/admin/subscriptions/${subs.items[0].id}`).set(as('platformAdmin')).send({ action: 'pause' }).expect(422)).body.message).toBe('Give a reason; it is logged.');
    await http.post(`/admin/subscriptions/${subs.items[0].id}`).set(as('platformAdmin')).send({ action: 'remind' }).expect(200);
    expect((await http.get('/admin/live').set(as('platformAdmin')).expect(200)).body.units.length).toBeGreaterThan(0);
  });

  it('filters by location: state, LGA, area, building or a typed postcode', async () => {
    const lagos = (await http.get('/admin/users?q=Ada&state=LA').set(as('platformAdmin')).expect(200)).body;
    expect(lagos[0]).toMatchObject({ name: 'Ada Obi' });
    expect((await http.get('/admin/users?q=Ada&state=FC').set(as('platformAdmin'))).body).toEqual([]);
    expect((await http.get('/admin/users?q=Ada&postcode=AB 12').set(as('platformAdmin'))).body).toHaveLength(1);
    expect((await http.get('/admin/subscriptions?area=LA-IKJ-01-MPL').set(as('platformAdmin'))).body.items).toHaveLength(1);
    expect((await http.get('/admin/subscriptions?building=ZZ99Z').set(as('platformAdmin'))).body.items).toHaveLength(0);
    const all = (await http.get('/admin/overview?lga=LA-IKJ').set(as('platformAdmin'))).body;
    expect(all.devices.total).toBe(4);
    expect((await http.get('/admin/overview?state=FC').set(as('platformAdmin'))).body.devices.total).toBe(0);
  });

  it('live map by type: emergencies, tips, public issues; an agency sees only its own', async () => {
    const id = (await http.post('/incidents').set(as('neighbour')).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    for (let i = 0; i < 60 && !['offered', 'escalated'].includes((await view('neighbour', id)).state); i++) await sleep(50);
    const live = (await http.get('/admin/live?kinds=emergency').set(as('platformAdmin')).expect(200)).body;
    expect(live.items.every((x: any) => x.kind === 'emergency')).toBe(true);
    expect(live.items.find((x: any) => x.id === id)).toMatchObject({ label: 'Robbery, AB12C', href: `/incidents/${id}` });
    expect(live.counts).toMatchObject({ tip: 0, issue: 0 });
    const ag = (await http.get(`/agencies/${agencyId}/live?kinds=emergency,tip,issue`).set(as('agencyAdmin')).expect(200)).body;
    expect(ag.items.some((x: any) => x.id === id)).toBe(true);
    expect((await http.get(`/agencies/${agencyId}/live?state=FC`).set(as('agencyAdmin'))).body.items).toEqual([]);
    await http.get(`/agencies/${agencyId}/live`).set(as('citizen')).expect(404);
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

describe('agency learn feed', () => {
  it('an agency posts in its own topics; the platform team reviews before it goes live', async () => {
    const src = (await http.get(`/agencies/${agencyId}/learn/sources`).set(as('agencyAdmin')).expect(200)).body;
    expect(src.topics).toEqual(expect.arrayContaining(['crime_prevention', 'scams_fraud']));
    expect(src.topics).not.toContain('fire_safety');
    const post = { title: 'Lock your gate at night', caption: 'Three habits that stop most break-ins.', topic: 'fire_safety', format: 'article', language: 'en', body: 'Lock the gate. Light the yard. Know your neighbours. '.repeat(10) };
    expect((await http.post(`/agencies/${agencyId}/learn/posts`).set(as('agencyAdmin')).send(post).expect(422)).body.message).toBe('Choose one of your agency’s topics.');
    const d = (await http.post(`/agencies/${agencyId}/learn/posts`).set(as('agencyAdmin')).send({ ...post, topic: 'home_security' }).expect(201)).body;
    const r = (await http.post(`/agencies/${agencyId}/learn/posts/${d.id}/actions`).set(as('agencyAdmin')).send({ event: 'submit' }).expect(201)).body;
    expect(r).toMatchObject({ state: 'in_review' });
    // Agencies cannot approve their own posts.
    await http.post(`/agencies/${agencyId}/learn/posts/${d.id}/actions`).set(as('agencyAdmin')).send({ event: 'approve' }).expect(409);
    const mine = (await http.get(`/agencies/${agencyId}/learn/posts?state=in_review`).set(as('agencyAdmin')).expect(200)).body;
    expect(mine.items.map((x: any) => x.id)).toEqual([d.id]);
    expect(mine.items[0].source).toBe('Nigeria Police Force (demo)');
    await http.post(`/admin/learn/posts/${d.id}/actions`).set(as('platformAdmin')).send({ event: 'approve' }).expect(201);
    expect((await http.get(`/learn/posts/${d.id}`).set(as('citizen')).expect(200)).body.title).toBe('Lock your gate at night');
    await http.get(`/agencies/${agencyId}/learn/posts?state=live`).set(as('citizen')).expect(404);
  });
});

describe('duplicates: suggest, merge, keep separate, split', () => {
  it('suggests a nearby report, merges it, and splits a joined report back out', async () => {
    // Start clean: earlier tests leave reports open at this building, and a new one would merge into them.
    await db.query(`update incident_units set state = 'released' where state in ('offered', 'accepted', 'en_route', 'on_scene')`);
    await db.query(`update incidents set state = 'cancelled' where state not in ('resolved', 'unfounded', 'cancelled', 'merged')`);
    const mk = async (who: string, body: Record<string, unknown>) => (await http.post('/incidents').set(as(who)).send({ clientRef: ref(), ...body }).expect(201)).body.id as string;
    const a = await mk('citizen', { type: 'riot', postcode: 'AB12C' });
    for (let i = 0; i < 60 && (await view('citizen', a)).state === 'pending_cancel'; i++) await sleep(50);
    // A GPS-only report 100 m away: not the same building, so not merged on its own.
    const b = await mk('neighbour', { type: 'violence', lat: 6.6027, lng: 3.3515 });
    for (let i = 0; i < 60 && (await view('neighbour', b)).state === 'pending_cancel'; i++) await sleep(50);
    const d = (await http.get(`/incidents/${a}/duplicates`).set(as('head')).expect(200)).body;
    const hit = d.find((x: any) => x.id === b);
    expect(hit).toBeTruthy();
    expect(hit.why).toMatch(/^Different building, related type/);
    await http.get(`/incidents/${a}/duplicates`).set(as('citizen')).expect(404);

    expect((await http.post(`/incidents/${a}/merge`).set(as('head')).send({ otherId: b }).expect(201)).body.message).toMatch(/^Merged\./);
    expect((await view('neighbour', b)).state).toBe('merged');
    const x = (await http.get(`/incidents/${a}/station-detail`).set(as('head'))).body;
    const joined = x.reports.find((r: any) => r.role === 'joined');
    expect(joined).toBeTruthy();
    expect((await http.get(`/incidents/${a}/duplicates`).set(as('head'))).body.find((y: any) => y.id === b)).toBeUndefined();

    const s = (await http.post(`/incidents/${a}/split`).set(as('head')).send({ reportId: joined.id }).expect(201)).body;
    expect(s.message).toBe('Split off. It has its own response now.');
    const fresh = await view('neighbour', s.id);
    expect(['received', 'offered', 'escalated']).toContain(fresh.state);
    const note = (await http.get('/me/notifications').set(as('neighbour'))).body.items.find((n: any) => n.type === 'report_split');
    expect(note.body).toMatch(/^Your report is a different emergency/);
    await http.post(`/incidents/${a}/split`).set(as('head')).send({ reportId: x.reports.find((r: any) => r.role === 'first').id }).expect(409);

    // Keep separate: never suggested again.
    await http.post(`/incidents/${a}/keep-separate`).set(as('head')).send({ otherId: s.id }).expect(201);
    expect((await http.get(`/incidents/${a}/duplicates`).set(as('head'))).body.find((y: any) => y.id === s.id)).toBeUndefined();
  });
});

describe('roster requests and message channels', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  it('an officer asks to swap; approving trades the two shifts on the roster', async () => {
    await http.put('/me/station/roster').set(as('head')).send({ officerId: users.officer, date: day(2), kind: 'night' }).expect(200);
    await http.put('/me/station/roster').set(as('head')).send({ officerId: users.officer2, date: day(3), kind: 'day' }).expect(200);
    await http.post('/me/officer/roster-requests').set(as('officer')).send({ kind: 'swap', otherOfficerId: users.officer, myDate: day(2), otherDate: day(3) }).expect(422);
    const r = (await http.post('/me/officer/roster-requests').set(as('officer')).send({ kind: 'swap', otherOfficerId: users.officer2, myDate: day(2), otherDate: day(3), note: 'Family event' }).expect(201)).body;
    const list = (await http.get('/me/station/roster/requests').set(as('head')).expect(200)).body;
    expect(list[0]).toMatchObject({ id: r.id, kind: 'swap', state: 'waiting', officer: 'Insp. Musa Bello', other: 'Sgt. Bola Ade' });
    expect(list[0].line).toMatch(/^Swap \w+ \d+ \w+ for \w+ \d+ \w+ with Sgt\. Bola Ade$/);
    await http.post(`/me/station/roster/requests/${r.id}`).set(as('head')).send({ decision: 'approve' }).expect(200);
    const kind = async (who: string, d: string) => (await db.query(`select coalesce((select kind from duty_shifts where officer_id = $1 and (starts_at at time zone 'Africa/Lagos')::date = $2::date limit 1), 'off') as k`, [users[who], d])).rows[0].k;
    expect([await kind('officer', day(2)), await kind('officer2', day(2)), await kind('officer2', day(3)), await kind('officer', day(3))]).toEqual(['off', 'night', 'off', 'day']);
    expect((await http.get('/me/notifications').set(as('officer2'))).body.items.some((x: any) => x.type === 'roster_decided')).toBe(true);
  });

  it('leave marks each day; a decline needs a reason', async () => {
    const r = (await http.post('/me/officer/roster-requests').set(as('officer2')).send({ kind: 'leave', fromDate: day(5), toDate: day(6) }).expect(201)).body;
    expect((await http.post(`/me/station/roster/requests/${r.id}`).set(as('head')).send({ decision: 'decline' }).expect(422)).body.message).toBe('Say why, so the officer knows.');
    await http.post(`/me/station/roster/requests/${r.id}`).set(as('head')).send({ decision: 'approve' }).expect(200);
    const n = (await db.query(`select count(*)::int as n from duty_shifts where officer_id = $1 and kind = 'leave'`, [users.officer2])).rows[0].n;
    expect(n).toBe(2);
    expect((await http.get('/me/officer/roster-requests').set(as('officer2'))).body[0]).toMatchObject({ kind: 'leave', state: 'approved' });
  });

  it('messages go by WhatsApp to staff who opted in, and by SMS to anyone who has not opened them', async () => {
    await http.patch('/me/preferences').set(as('officer')).send({ whatsappOptIn: true }).expect(200);
    const s = (await http.post('/me/station/messages').set(as('head')).send({ audience: 'everyone', title: 'Briefing', body: 'Briefing at 7pm.', whatsapp: true, sms: 'unread', smsAfterMinutes: 5 }).expect(201)).body;
    expect(s.message).toBe('Sent to 2 officers (1 on WhatsApp, SMS to anyone who has not opened it in 5 min).');
    const wa = (await http.get('/dev/whatsapp')).body;
    expect(wa[wa.length - 1]).toMatchObject({ to: '+2348030000002', body: 'Station 4 Ikeja: Briefing. Briefing at 7pm.' });
    await http.get(`/me/messages/${s.id}`).set(as('officer')).expect(200);
    await db.query(`update station_broadcasts set created_at = now() - interval '10 minutes' where id = $1`, [s.id]);
    const ran = (await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body;
    expect(ran.messagesTexted).toBe(1);
    const d = (await http.get(`/me/station/messages/${s.id}`).set(as('head'))).body;
    expect(d.channels).toEqual(['push', 'whatsapp', 'sms']);
    const r2 = d.recipients.find((x: any) => x.id === users.officer2);
    expect(r2.smsAt).toBeTruthy();
    expect(d.recipients.find((x: any) => x.id === users.officer).smsAt).toBeNull();
  });
});
