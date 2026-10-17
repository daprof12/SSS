// Phase 1 (report and dispatch MVP) backend: officer duty, location and Home,
// ratings, the notification centre and overflow to the next station.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
let ref = 0;

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
const report = async (who: string, body: Record<string, unknown>) =>
  (await http.post('/incidents').set(as(who)).send({ clientRef: `phase1-${who}-${++ref}-${Date.now()}`, ...body }).expect(201)).body.id as string;
/** Whichever officer currently holds the offer. */
async function offeredTo(id: string): Promise<string> {
  const v = await waitFor(() => view('citizen', id), (x) => x.state === 'offered');
  expect(v.state).toBe('offered');
  for (const who of ['officer', 'officer2']) if ((await view(who, id)).view === 'officer') return who;
  throw new Error('no officer holds the offer');
}
async function resolve(id: string, who: string) {
  for (const event of ['accept', 'start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event }).expect(201);
  await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'close_valid', outcomeCode: 'resolved_on_scene' }).expect(201);
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});

afterAll(async () => {
  await app?.close();
});

// Each test starts with every report closed and both officers free and on duty at Station 4.
beforeEach(async () => {
  await db.query(`update incident_units set state = 'released' where state in ('offered', 'accepted', 'en_route', 'on_scene')`);
  await db.query(`update incidents set state = 'cancelled', closed_at = now() where state not in ('resolved', 'unfounded', 'cancelled', 'merged')`);
  await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint(3.352, 6.6015), 4326)::geography where user_id = $2`, [stationId, users.officer]);
  await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint(3.36, 6.61), 4326)::geography where user_id = $2`, [stationId, users.officer2]);
});

describe('officer duty and location', () => {
  it('needs location and a verified badge to go on duty', async () => {
    const noLoc = await http.patch('/me/officer/duty').set(as('officer')).send({ onDuty: true }).expect(422);
    expect(noLoc.body.message).toBe('Turn on location to receive offers.');
    await db.query(`update officers set badge_status = 'pending' where user_id = $1`, [users.officer]);
    const badge = await http.patch('/me/officer/duty').set(as('officer')).send({ onDuty: true, location: { lat: 6.6, lng: 3.35 } }).expect(409);
    expect(badge.body.message).toBe('You cannot take reports until your badge is verified.');
    await http.patch('/me/officer/duty').set(as('citizen')).send({ onDuty: false }).expect(403);
  });

  it('blocks going off duty with an active incident, and re-routes open offers when going off duty', async () => {
    const id = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const first = await offeredTo(id);
    const other = first === 'officer' ? 'officer2' : 'officer';

    // Off duty while only offered: the offer goes straight to the other officer.
    expect((await http.patch('/me/officer/duty').set(as(first)).send({ onDuty: false }).expect(200)).body.message).toBe('You are off duty. You will not get offers.');
    const v = await waitFor(() => view(other, id).catch(() => ({})), (x: any) => x.view === 'officer');
    expect(v.state).toBe('offered');

    await http.post(`/incidents/${id}/actions`).set(as(other)).send({ event: 'accept' }).expect(201);
    const blocked = await http.patch('/me/officer/duty').set(as(other)).send({ onDuty: false }).expect(409);
    expect(blocked.body.message).toBe('You still have an active incident. Hand it over before going off duty.');
  });

  it('updates the citizen ETA from location pings while en route', async () => {
    const id = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const who = await offeredTo(id);
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'start_route' }).expect(201);

    // About 5 km away at 30 km/h → 10 minutes.
    expect((await http.post('/me/officer/location').set(as(who)).send({ lat: 6.6468, lng: 3.3515 }).expect(200)).body.etaUpdated).toBe(1);
    expect((await view('citizen', id)).status.line).toBe('About 10 min.');
    await http.post('/me/officer/location').set(as(who)).send({ lat: 6.6025, lng: 3.3515 }).expect(200);
    expect((await view('citizen', id)).etaMinutes).toBe(1);
  });

  it('fills the Home tabs with the States doc empty messages', async () => {
    const empty = (await http.get('/me/officer/home').set(as('officer')).expect(200)).body;
    expect(empty).toMatchObject({ onDuty: true, banner: null });
    expect(empty.tabs.offers).toEqual({ items: [], empty: 'No offers right now. Stay on duty and keep the app open.' });

    const id = await report('citizen', { type: 'riot', postcode: 'AB12C' });
    const who = await offeredTo(id);
    const home = (await http.get('/me/officer/home').set(as(who)).expect(200)).body;
    expect(home.tabs.offers.items[0]).toMatchObject({ id, type: 'riot', postcode: 'AB12C', distance_m: expect.any(Number), secondsLeft: expect.any(Number) });
    await resolve(id, who);
    const done = (await http.get('/me/officer/home').set(as(who)).expect(200)).body;
    expect(done.tabs.done.items.map((x: any) => x.id)).toContain(id);
    expect(done.today.closed).toBeGreaterThanOrEqual(1);
    expect(done.today.avgArrival).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('officer panic (B1)', () => {
  it('tells the station head and the other on-duty officers at once', async () => {
    const id = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const who = await offeredTo(id);
    const other = who === 'officer' ? 'officer2' : 'officer';
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);
    await http.post(`/incidents/${id}/events`).set(as(who)).send({ kind: 'officer_panic' }).expect(201);
    const name = who === 'officer' ? 'Insp. Musa Bello' : 'Sgt. Bola Ade';
    for (const to of ['head', other]) {
      const n = (await http.get('/me/notifications').set(as(to))).body.items.find((x: any) => x.type === 'officer_panic');
      expect(n, to).toMatchObject({ title: 'Officer needs help', body: `${name} needs help at AB12C.` });
    }
    // The reporter is never told (A4).
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.some((x: any) => x.type === 'officer_panic')).toBe(false);
  });
});

describe('rating the response (SRS TRUST-4)', () => {
  it('opens only after close, once per reporter, and tells the officer', async () => {
    const id = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const who = await offeredTo(id);
    const early = await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 5 }).expect(409);
    expect(early.body.message).toBe('You can rate the response once the report is closed.');
    await resolve(id, who);

    await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 6 }).expect(400);
    await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 5, tags: ['bribe'] }).expect(400);
    await http.post(`/incidents/${id}/rating`).set(as('neighbour')).send({ stars: 1 }).expect(404);
    expect((await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 4, tags: ['fast', 'polite'], comment: 'Came quickly' }).expect(201)).body.ok).toBe(true);
    const again = await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 1 }).expect(409);
    expect(again.body.message).toBe('You already rated this response. Thank you.');

    const notes = (await http.get('/me/notifications').set(as(who)).expect(200)).body.items;
    expect(notes.find((n: any) => n.type === 'rating_received').body).toBe('You got 4 stars for Robbery at AB12C.');
    expect((await view(who, id)).rating).toMatchObject({ stars: 4, comment: 'Came quickly' });
  });
});

describe('notification centre', () => {
  it('tells the reporter each step, with tabs, unread count and mark all read', async () => {
    await http.post('/me/notifications/read-all').set(as('citizen')).expect(204);
    const id = await report('citizen', { type: 'fire', postcode: 'AB12C' });
    // Fire routes nowhere in the seed (no fire agency), so only "received" arrives.
    await waitFor(() => view('citizen', id), (v) => v.state === 'received');
    const r = (await http.get('/me/notifications?tab=reports').set(as('citizen')).expect(200)).body;
    expect(r.unread).toBeGreaterThanOrEqual(1);
    expect(r.items[0]).toMatchObject({ type: 'report_received', title: 'Report received', body: 'We got your report. Finding the nearest team.', link: `/reports/${id}`, unread: true });
    expect((await http.get('/me/notifications?tab=money').set(as('citizen')).expect(200)).body.items).toEqual([]);

    const id2 = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const who = await offeredTo(id2);
    const offer = (await http.get('/me/notifications').set(as(who))).body.items.find((n: any) => n.type === 'new_offer');
    expect(offer.body).toMatch(/^Robbery at AB12C\. Accept within \d+ seconds\.$/);
    await resolve(id2, who);
    const titles = (await http.get('/me/notifications').set(as('citizen'))).body.items.map((n: any) => n.title);
    expect(titles).toEqual(expect.arrayContaining(['Help accepted', 'Help has arrived', 'Report closed']));

    await http.post(`/me/notifications/${r.items[0].id}/read`).set(as('citizen')).expect(204);
    await http.post('/me/notifications/read-all').set(as('citizen')).expect(204);
    expect((await http.get('/me/notifications').set(as('citizen'))).body.unread).toBe(0);
  });

  it('keeps discreet reports neutral', async () => {
    await http.post('/me/notifications/read-all').set(as('citizen')).expect(204);
    const id = await report('citizen', { type: 'violence', postcode: 'AB12C', discreet: true });
    const who = await offeredTo(id);
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);
    const items = (await http.get('/me/notifications').set(as('citizen'))).body.items.filter((n: any) => n.link === `/reports/${id}`);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const n of items) expect(n).toMatchObject({ title: 'Update', body: 'Your request is in progress.' });
  });
});

describe('overflow to the next station (Roster doc)', () => {
  it('passes the report on when nobody at the nearest station is free, and tells its head', async () => {
    const agency = (await db.query(`select agency_id from stations where id = $1`, [stationId])).rows[0].agency_id;
    const st2 = (await db.query(`insert into stations (agency_id, name, status) values ($1, 'Station 9 Yaba', 'active') returning id`, [agency])).rows[0].id;
    await db.query(`update officers set station_id = $1 where user_id = $2`, [st2, users.officer2]);
    await db.query(`update officers set on_duty = false where user_id = $1`, [users.officer]);
    await http.post('/me/notifications/read-all').set(as('head')).expect(204);

    const id = await report('citizen', { type: 'kidnapping', postcode: 'AB12C' });
    const v = await waitFor(() => view('officer2', id).catch(() => ({})), (x: any) => x.view === 'officer' && x.state === 'offered');
    expect(v.state).toBe('offered');
    expect((await view('citizen', id)).timeline.map((e: any) => e.label)).toContain('Passed to the next station');
    const head = (await http.get('/me/notifications').set(as('head'))).body.items;
    expect(head[0]).toMatchObject({ type: 'no_one_on_duty', body: 'No one is free at your station. A kidnapping report went to Station 9 Yaba.' });
  });

  it('tells the station head when no station has anyone free', async () => {
    await db.query(`update officers set on_duty = false`);
    await http.post('/me/notifications/read-all').set(as('head')).expect(204);
    const id = await report('citizen', { type: 'robbery', postcode: 'AB12C' });
    const items = await waitFor(
      () => http.get('/me/notifications').set(as('head')).then((r) => r.body.items as any[]),
      (xs) => xs.some((x) => x.type === 'nobody_accepted' && x.link === `/incidents/${id}`),
    );
    const n = items.find((x) => x.type === 'nobody_accepted');
    expect(n).toMatchObject({ type: 'nobody_accepted', title: 'Nobody accepted', link: `/incidents/${id}` });
    expect((await view('citizen', id)).state).toBe('received');
    // Handed back to the station that covers the area, so it shows in that queue.
    expect((await http.get('/me/queue').set(as('head'))).body.map((r: any) => r.id)).toContain(id);
  });
});
