// Station assign and reassign: offer to a chosen officer, send one directly once a report stalls,
// move it to another officer, and the officer's "can't go". Every step has a reason and an audit row.
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
const ref = () => `assign-${Date.now()}-${++n}`;
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
const units = async (id: string) =>
  (await db.query(`select officer_id, state, assign_mode, assign_reason, cant_go_reason from incident_units where incident_id = $1 order by offered_at`, [id])).rows;
const offeredTo = async (id: string) => (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows[0]?.officer_id;
const who = (userId: string) => Object.keys(users).find((k) => users[k] === userId)!;
const audits = async (id: string) => (await db.query(`select action from audit_log where entity_id = $1 order by id`, [id])).rows.map((r) => r.action);
const notes = async (userId: string, type: string) => (await db.query(`select body from notifications where user_id = $1 and type = $2 order by sent_at desc, id desc`, [userId, type])).rows;

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

describe('station assign, reassign and can’t go', () => {
  let id: string;
  let a: string; // first officer offered it
  let b: string; // the other one

  it('offers to a chosen officer in place of a running offer, without counting against the first', async () => {
    id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    await waitFor(() => view('citizen', id), (x) => x.state === 'offered');
    a = who(await offeredTo(id));
    b = a === 'officer' ? 'officer2' : 'officer';

    const head = await view('head', id);
    expect(head.actions).toEqual(expect.arrayContaining(['assign', 'direct_assign']));
    expect(head.canDirectAssign).toBe(false);
    // Not stalled yet: a direct assignment is refused.
    const early = await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users[b], mode: 'direct', reason: 'Closer' }).expect(409);
    expect(early.body.code).toBe('not_stalled');

    const r = (await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users[b], reason: 'Knows the area' }).expect(201)).body;
    expect(r).toMatchObject({ state: 'offered', message: expect.stringMatching(/^Offered to /) });
    expect(await offeredTo(id)).toBe(users[b]);
    const first = (await http.get(`/incidents/${id}/offer`).set(as(a)).expect(200)).body;
    expect(first).toMatchObject({ state: 'withdrawn', counted: false });
    expect(await notes(users[a], 'offer_withdrawn')).toHaveLength(1);
    expect(await audits(id)).toContain('incident.assign_offer');
  });

  it('sends an officer directly once the report stalls, with a reason', async () => {
    // The chosen officer declines: the report has now stalled.
    await http.post(`/incidents/${id}/decline`).set(as(b)).send({ reason: 'busy' }).expect(201);
    await waitFor(() => view('head', id), (x) => x.canDirectAssign === true);

    await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users[a], mode: 'direct' }).expect(422);
    const r = (await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users[a], mode: 'direct', reason: 'Nearest free officer, please go now.' }).expect(201)).body;
    expect(r).toMatchObject({ state: 'accepted' });
    expect((await units(id)).filter((u) => u.state === 'offered')).toEqual([]);

    const mine = await view(a, id);
    expect(mine.assignment).toMatchObject({ mode: 'direct', by: 'CSP Ngozi Eze', reason: 'Nearest free officer, please go now.', canSayCantGo: true });
    expect((await notes(users[a], 'direct_assignment'))[0].body).toMatch(/^Go to Robbery at AB12C now\. Nearest free officer/);
    expect((await notes(users.citizen, 'team_accepted')).length).toBeGreaterThan(0);
    expect(await audits(id)).toContain('incident.assign_direct');
  });

  it('reassigns to another officer the station chooses', async () => {
    await http.post(`/incidents/${id}/reassign`).set(as('head')).send({ officerId: users[b] }).expect(400);
    await http.post(`/incidents/${id}/reassign`).set(as('citizen')).send({ officerId: users[b], reason: 'x' }).expect(403);
    const r = (await http.post(`/incidents/${id}/reassign`).set(as('head')).send({ officerId: users[b], reason: 'Officer needed elsewhere' }).expect(201)).body;
    expect(r).toMatchObject({ state: 'accepted' });
    const us = await units(id);
    expect(us.find((u) => u.officer_id === users[a] && u.assign_mode === 'direct')).toMatchObject({ state: 'released' });
    expect(us.find((u) => u.officer_id === users[b] && u.assign_mode === 'reassign')).toMatchObject({ state: 'accepted', assign_reason: 'Officer needed elsewhere' });
    expect((await notes(users[a], 'reassigned_off'))[0].body).toMatch(/Officer needed elsewhere$/);
    expect((await notes(users.citizen, 'officer_changed'))[0].body).toMatch(/is coming instead\.$/);
    expect((await view('head', id)).timeline.map((e: any) => e.label)).toContain('Changing officers');
    expect(await audits(id)).toContain('incident.reassign');
  });

  it('lets the officer sent say they can’t go; it goes to the next free officer and is not held against them', async () => {
    await http.post(`/incidents/${id}/cant-go`).set(as(b)).send({ reason: 'other' }).expect(422);
    const r = (await http.post(`/incidents/${id}/cant-go`).set(as(b)).send({ reason: 'vehicle' }).expect(201)).body;
    expect(r.message).toBe('Your station has been told. This is not held against you.');
    expect((await units(id)).find((u) => u.officer_id === users[b] && u.state === 'cant_go')).toMatchObject({ cant_go_reason: 'No vehicle, or it broke down' });
    expect((await notes(users.head, 'cant_go'))[0].body).toMatch(/can't go to Robbery at AB12C: No vehicle, or it broke down\. It is being offered to the next free officer\.$/);
    await waitFor(() => offeredTo(id), (x) => x === users[a]);
    expect(await audits(id)).toContain('incident.cant_go');
    const profile = (await http.get('/me/officer/profile').set(as(b)).expect(200)).body;
    expect(profile.acceptance.missed).toBe(0);
  });

  it('keeps "can’t go" for officers who were sent, and stands down a second unit without moving the report', async () => {
    await http.post(`/incidents/${id}/actions`).set(as(a)).send({ event: 'accept' }).expect(201);
    expect((await view(a, id)).assignment).toMatchObject({ mode: 'self', canSayCantGo: false });
    expect((await http.post(`/incidents/${id}/cant-go`).set(as(a)).send({ reason: 'unwell' }).expect(409)).body.code).toBe('self_accepted');

    await http.post(`/incidents/${id}/reinforce`).set(as('head')).send({ officerId: users[b] }).expect(201);
    expect((await view(b, id)).assignment).toMatchObject({ mode: 'reinforcement', canSayCantGo: true });
    await http.post(`/incidents/${id}/cant-go`).set(as(b)).send({ reason: 'other', note: 'Flat tyre on the way' }).expect(201);
    expect((await view('head', id)).state).toBe('accepted');
    expect((await notes(users.head, 'cant_go'))[0].body).toMatch(/Other: Flat tyre on the way\. Send someone else if you still need a second unit\.$/);
  });
});
