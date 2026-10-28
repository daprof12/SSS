// Smart-device control centre (agencies with device access) and report messages between citizen and responders.
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
let agencyId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Clears earlier reports so each test routes a fresh one (no duplicate merge, officers free). */
async function fresh() {
  await db.query(`update incident_units set state = 'released' where state in ('offered', 'accepted', 'en_route', 'on_scene')`);
  await db.query(`update incidents set state = 'cancelled' where state not in ('cancelled', 'resolved')`);
}
async function waitOffered(id: string) {
  for (let i = 0; i < 50; i++) {
    const v = (await http.get(`/incidents/${id}`).set(as('citizen'))).body;
    if (v.state === 'offered') return;
    await sleep(100);
  }
  throw new Error('not offered');
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  agencyId = seed.agencyId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

describe('control centre', () => {
  it('lets an agency with device access see and operate its devices', async () => {
    const o = (await http.get('/control').set(as('agencyAdmin')).expect(200)).body;
    expect(o.devices.map((d: any) => d.type)).toEqual(expect.arrayContaining(['smart_pole', 'defence_drone', 'fire_drone', 'body_cam', 'camera', 'sensor']));
    const pole = o.devices.find((d: any) => d.type === 'smart_pole');
    expect(pole.can).toContain('deploy');

    await fresh();
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'CD34E', clientRef: `fleet-${Date.now()}` }).expect(201)).body.id;
    await waitOffered(id);
    const scene = (await http.get(`/control/incidents/${id}`).set(as('head')).expect(200)).body;
    expect(scene.nearby.length).toBeGreaterThan(0);
    expect(scene.nearby[0].distanceM).toBeLessThanOrEqual(600);
    expect(scene.drones.length).toBeGreaterThan(0);

    // Launching the pole launches the drone docked on it.
    const sent = (await http.post(`/control/devices/${pole.id}/commands`).set(as('dispatcher')).send({ command: 'goto_scene', incidentId: id }).expect(201)).body;
    expect(sent.message).toMatch(/flying to the report/);
    const after = (await http.get('/control').set(as('agencyAdmin')).expect(200)).body;
    expect(after.devices.find((d: any) => d.name === 'Defence drone 1').state).toBe('deployed');
    expect(after.commands[0]).toMatchObject({ command: 'goto_scene' });
  });

  it('shows a body cam once its officer is on the report', async () => {
    await fresh();
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'CD34E', clientRef: `cam-${Date.now()}` }).expect(201)).body.id;
    await waitOffered(id);
    let who = '';
    for (const w of ['officer', 'officer2']) if ((await http.get(`/incidents/${id}`).set(as(w))).body.view === 'officer') who = w;
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);
    const scene = (await http.get(`/control/incidents/${id}`).set(as('agencyAdmin')).expect(200)).body;
    expect(scene.bodyCams).toHaveLength(1);
    expect(scene.bodyCams[0].type).toBe('body_cam');
  });

  it('refuses commands a device cannot do, and people without access', async () => {
    const o = (await http.get('/control').set(as('agencyAdmin')).expect(200)).body;
    const sensor = o.devices.find((d: any) => d.type === 'sensor');
    await http.post(`/control/devices/${sensor.id}/commands`).set(as('agencyAdmin')).send({ command: 'deploy' }).expect(422);
    await http.get('/control').set(as('officer')).expect(403);
    await http.get('/control').set(as('citizen')).expect(403);
    await http.post('/admin/fleet/devices').set(as('agencyAdmin')).send({ type: 'camera', serial: 'X-1234', agencyId }).expect(403);
  });

  it('is switched on by a platform admin when onboarding', async () => {
    await db.query(`update agencies set device_access = false where id = $1`, [agencyId]);
    await http.get('/control').set(as('agencyAdmin')).expect(403);
    await http.post(`/admin/agencies/${agencyId}/device-access`).set(as('platformAdmin')).send({ enabled: true }).expect(201);
    await http.get('/control').set(as('agencyAdmin')).expect(200);
    const reg = await http.post('/admin/fleet/devices').set(as('platformAdmin')).send({ type: 'camera', serial: 'CM-TEST-0009', name: 'Test camera', agencyId, lat: 6.6, lng: 3.35 }).expect(201);
    expect(reg.body.message).toMatch(/registered/);
    await http.post('/admin/fleet/devices').set(as('platformAdmin')).send({ type: 'camera', serial: 'CM-TEST-0009', agencyId }).expect(409);
  });
});

describe('report messages', () => {
  it('lets the citizen and the officer on a report message each other', async () => {
    await fresh();
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'riot', postcode: 'CD34E', clientRef: `msg-${Date.now()}` }).expect(201)).body.id;
    await waitOffered(id);
    let who = '';
    for (const w of ['officer', 'officer2']) if ((await http.get(`/incidents/${id}`).set(as(w))).body.view === 'officer') who = w;
    await http.post(`/incidents/${id}/actions`).set(as(who)).send({ event: 'accept' }).expect(201);

    await http.post(`/incidents/${id}/messages`).set(as(who)).send({ body: 'I am two minutes away. Stay inside.' }).expect(201);
    await http.post(`/incidents/${id}/messages`).set(as('citizen')).send({ body: 'Blue gate, second house.' }).expect(201);
    const asCitizen = (await http.get(`/incidents/${id}/messages`).set(as('citizen')).expect(200)).body;
    expect(asCitizen.you).toBe('citizen');
    expect(asCitizen.messages.map((m: any) => [m.side, m.mine])).toEqual([['responder', false], ['citizen', true]]);
    const note = await db.query(`select title from notifications where user_id = $1 and type = 'report_message'`, [users.citizen]);
    expect(note.rows).toHaveLength(1);
    const asOfficer = (await http.get(`/incidents/${id}/messages`).set(as(who)).expect(200)).body;
    expect(asOfficer.you).toBe('responder');
    // A stranger sees nothing; the neighbour is not on the report.
    await http.get(`/incidents/${id}/messages`).set(as('neighbour')).expect(404);
    await http.post(`/incidents/${id}/messages`).set(as('neighbour')).send({ body: 'hi' }).expect(404);
    await http.post(`/incidents/${id}/messages`).set(as('citizen')).send({ body: '  ' }).expect(400);
  });
});
