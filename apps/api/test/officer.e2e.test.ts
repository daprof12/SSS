// Officer app beyond dispatch: History, activity detail, Team, Profile, shifts and field reports.
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
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ref = () => `officer-${Date.now()}-${++n}`;
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await fn();
  }
  return v;
}
const view = async (who: string, id: string) => (await http.get(`/incidents/${id}`).set(as(who))).body;
async function respond(type: string, stars: number, tags: string[], comment?: string) {
  const id = (await http.post('/incidents').set(as('citizen')).send({ type, postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
  const v = await waitFor(() => view('citizen', id), (x) => x.state === 'offered');
  let who = '';
  for (const w of ['officer', 'officer2']) if ((await view(w, id)).view === 'officer') who = w;
  if (!who) throw new Error(`not offered: ${v.state}`);
  for (const event of ['accept', 'start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event }).expect(201);
  await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'close_valid', outcomeCode: 'arrest' }).expect(201);
  await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars, tags, comment }).expect(201);
  return { id, who };
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
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

describe('history and activity detail', () => {
  it('shows the station’s responses with ratings, mine marked, and the detail', async () => {
    const a = await respond('robbery', 5, ['fast', 'polite', 'clear'], 'They came in minutes');
    await respond('riot', 3, ['slow']);

    const h = (await http.get('/me/officer/history').set(as(a.who)).expect(200)).body;
    expect(h.items).toHaveLength(2);
    expect(h.items.find((x: any) => x.id === a.id)).toMatchObject({ title: 'Robbery, AB12C', mine: true, stars: 5, resolved: true, people: 'You' });
    expect(h.stats.teamRating).toBe(4);
    expect(h.stats.myRating).not.toBeNull();
    const mine = (await http.get('/me/officer/history?filter=mine').set(as(a.who))).body.items;
    expect(mine.every((x: any) => x.mine)).toBe(true);

    const d = (await http.get(`/me/officer/history/${a.id}`).set(as(a.who)).expect(200)).body;
    expect(d).toMatchObject({ title: 'Robbery, AB12C', stars: 5, outcome: 'Arrest made', reportsMerged: 1, comment: 'They came in minutes', rewardNote: expect.stringMatching(/^Reward ₦5,000\.00 split by the Station 4 Ikeja rule\. Paid to wallets on /) });
    expect(d.team[0]).toMatchObject({ name: 'You', you: true, role: 'Lead' });
    expect(d.arrivalS).toBeGreaterThanOrEqual(0);
    await http.get(`/me/officer/history/${a.id}`).set(as('citizen')).expect(403);
  });
});

describe('team and profile', () => {
  it('lists the team with duty, shifts and ratings', async () => {
    const team = (await http.get('/me/officer/team').set(as('officer')).expect(200)).body;
    expect(team.name).toBe('Station 4 Ikeja');
    expect(team.members.find((m: any) => m.you)).toMatchObject({ name: 'You', onDuty: true });
    expect(team.members).toHaveLength(2);
    expect(team.stats.responses).toBe(2);
    expect(team.shifts.length).toBeGreaterThan(0);
    expect(team.activity.length).toBeGreaterThan(0);
  });

  it('shows the profile with sub-ratings from rating tags', async () => {
    const p = (await http.get('/me/officer/profile').set(as('officer')).expect(200)).body;
    expect(p).toMatchObject({ station: 'Station 4 Ikeja', badge: { status: 'verified' }, team: { officers: 2 } });
    expect(Object.keys(p.rating)).toEqual(expect.arrayContaining(['overall', 'count', 'arrival', 'care', 'solved']));
    const s = (await http.get('/me/officer/shifts').set(as('officer')).expect(200)).body;
    expect(s.shifts[0]).toMatchObject({ kind: expect.any(String) });
  });
});

describe('field reports', () => {
  it('files a report from the field, linked to an incident the officer is on', async () => {
    const live = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'CD34E', clientRef: ref() }).expect(201)).body.id;
    await waitFor(() => view('citizen', live), (x) => x.state === 'offered');
    let who = '';
    for (const w of ['officer', 'officer2']) if ((await view(w, live)).view === 'officer') who = w;
    await http.post(`/incidents/${live}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);

    const links = (await http.get('/me/officer/field-reports/linkable').set(as(who)).expect(200)).body;
    expect(links.find((x: any) => x.id === live)).toMatchObject({ title: 'Robbery, CD34E', live: true });

    const body = { type: 'robbery', description: 'Two suspects fled toward Allen roundabout on a red motorcycle.', postcode: 'CD34E', incidentId: live, clientRef: ref() };
    expect((await http.post('/me/officer/field-reports').set(as(who)).send({ ...body, description: 'short' }).expect(422)).body.message).toBe('Say what you saw in a sentence or two.');
    const r = (await http.post('/me/officer/field-reports').set(as(who)).send(body).expect(201)).body;
    expect(r).toMatchObject({ linked: true, duplicate: false });
    expect((await http.post('/me/officer/field-reports').set(as(who)).send(body).expect(201)).body).toMatchObject({ id: r.id, duplicate: true });
    const ev = await db.query(`select payload from incident_events where incident_id = $1 and kind = 'field_report'`, [live]);
    expect(ev.rows[0].payload.label).toBe('Field report added');

    // Not linked: a building picked on the map, plus a photo.
    const other = (
      await http.post('/me/officer/field-reports').set(as(who)).send({ type: 'other', description: 'Exposed live cable hanging over the market entrance.', lat: 6.6016, lng: 3.3517, clientRef: ref() }).expect(201)
    ).body;
    const reg = (await http.post('/media').set(as(who)).send({ ownerType: 'field_report', ownerId: other.id, contentType: 'image/png', sizeBytes: 32 }).expect(201)).body;
    await http.put(reg.uploadUrl).set(as(who)).set('Content-Type', 'image/png').send(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)])).expect(200);
    await http.get('/attachments').query({ ownerType: 'field_report', ownerId: other.id }).set(as('head')).expect(200);
    await http.post('/media').set(as('citizen')).send({ ownerType: 'field_report', ownerId: other.id, contentType: 'image/png', sizeBytes: 32 }).expect(404);

    const mine = (await http.get('/me/officer/field-reports').set(as(who)).expect(200)).body;
    expect(mine[0]).toMatchObject({ title: 'Other danger', linked: false, files: 1 });
    expect(mine[1]).toMatchObject({ title: 'Robbery, CD34E', linked: true });
  });
});

describe('report map', () => {
  it('shows each side its distance, time and route to the report', async () => {
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'riot', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    await waitFor(() => view('citizen', id), (x) => x.state === 'offered');
    const offered = (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows[0].officer_id;
    const who = Object.keys(users).find((k) => users[k] === offered)!;

    // The offered officer sees how far they are, from the phone position they send.
    const o = (await http.get(`/incidents/${id}/map?lat=6.6&lng=3.35`).set(as(who)).expect(200)).body;
    expect(o.incident).toMatchObject({ type: 'riot', lat: expect.any(Number), lng: expect.any(Number), label: expect.stringMatching(/^Riot, /) });
    expect(o.you).toEqual({ lat: 6.6, lng: 3.35 });
    expect(o.units).toHaveLength(1);
    expect(o.units[0]).toMatchObject({ isYou: true, state: 'offered', lat: 6.6, lng: 3.35, route: { source: 'estimate', distanceM: expect.any(Number), durationS: expect.any(Number) } });
    expect(o.units[0].route.line).toHaveLength(2);
    expect(o.units[0].route.distanceM).toBeGreaterThan(o.youDistanceM);

    // The citizen sees no one until an officer accepts, then the officer's way to them.
    expect((await http.get(`/incidents/${id}/map`).set(as('citizen')).expect(200)).body.units).toEqual([]);
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);
    const after = (await http.get(`/incidents/${id}/map`).set(as('citizen')).expect(200)).body;
    expect(after.units).toEqual([expect.objectContaining({ state: 'accepted', role: 'primary', isYou: false, name: expect.any(String), route: expect.objectContaining({ source: 'estimate' }) })]);

    // A second unit: everyone sees both officers, each with their own distance and time.
    const other = who === 'officer' ? 'officer2' : 'officer';
    await db.query(`update incident_units set state = 'released' where officer_id = $1 and state in ('accepted', 'en_route', 'on_scene')`, [users[other]]);
    await http.post(`/incidents/${id}/reinforce`).set(as('head')).send({ officerId: users[other] }).expect(201);
    const both = (await http.get(`/incidents/${id}/map`).set(as('citizen')).expect(200)).body.units;
    expect(both).toHaveLength(2);
    expect(both.map((u: any) => u.role).sort()).toEqual(['primary', 'reinforcement']);
    expect(both[0].route.durationS).toBeLessThanOrEqual(both[1].route.durationS);
    const theirs = (await http.get(`/incidents/${id}/map`).set(as(other)).expect(200)).body.units;
    expect(theirs.find((u: any) => u.isYou)).toMatchObject({ role: 'reinforcement', route: expect.any(Object) });
    expect(theirs.filter((u: any) => !u.isYou)).toHaveLength(1);

    // The report shows them as one team, lead first, to the citizen and to each officer.
    const team = (await http.get(`/incidents/${id}`).set(as('citizen')).expect(200)).body.team;
    expect(team.map((m: any) => m.role)).toEqual(['Lead', 'Second unit']);
    expect(team[0]).toEqual({ name: expect.any(String), badgeNo: expect.any(String), stationName: 'Station 4 Ikeja', rating: null, role: 'Lead' });
    expect((await http.get(`/incidents/${id}`).set(as(other)).expect(200)).body.team.map((m: any) => m.you)).toEqual([false, true]);
    expect((await http.get(`/incidents/${id}`).set(as('head')).expect(200)).body.team).toHaveLength(2);

    // Station staff see it too; anyone else does not.
    expect((await http.get(`/incidents/${id}/map`).set(as('head')).expect(200)).body.units).toHaveLength(2);
    await http.get(`/incidents/${id}/map`).set(as('neighbour')).expect(404);
    await http.get(`/incidents/${id}/map?lat=200&lng=3`).set(as(who)).expect(400);
  });
});
