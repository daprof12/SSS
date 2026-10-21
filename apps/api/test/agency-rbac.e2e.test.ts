// Role-based access for platform, agency and station staff, and the agency boards: officers,
// equipment, routing rules, billing, assets, settings, team, station detail and messaging.
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
let naptipId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

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
  naptipId = seed.naptipId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

describe('role-based access', () => {
  it('platform finance: money pages only', async () => {
    await http.get('/admin/subscriptions').set(as('platformFinance')).expect(200);
    await http.get('/admin/donations').set(as('platformFinance')).expect(200);
    expect((await http.get('/admin/audit').set(as('platformFinance')).expect(403)).body.message).toMatch(/^Your role does not include this/);
    await http.get('/admin/coverage').set(as('platformFinance')).expect(403);
    await http.get('/admin/support').set(as('platformFinance')).expect(403);
  });

  it('platform support: help, users, KYC; not payouts or AI', async () => {
    await http.get('/admin/support').set(as('platformSupport')).expect(200);
    await http.get('/admin/users').set(as('platformSupport')).expect(200);
    await http.get('/admin/kyc').set(as('platformSupport')).expect(200);
    await http.get('/admin/payouts').set(as('platformSupport')).expect(403);
    await http.get('/admin/ai').set(as('platformSupport')).expect(403);
  });

  it('platform operations: devices, but a live camera view stays with platform admins', async () => {
    const c = (await http.get('/admin/coverage').set(as('platformOps')).expect(200)).body;
    const cam = c.devices.find((d: any) => d.type === 'camera');
    await db.query(`update devices set status = 'online' where id = $1`, [cam.id]);
    await http.post(`/admin/devices/${cam.id}/live`).set(as('platformOps')).send({ reason: 'Tamper check' }).expect(403);
    await http.post(`/admin/devices/${cam.id}/live`).set(as('platformAdmin')).send({ reason: 'Tamper check' }).expect(201);
    await http.get('/admin/users').set(as('platformOps')).expect(403);
  });

  it('agency finance: billing yes, operations no; another agency is invisible', async () => {
    await http.get(`/agencies/${agencyId}/billing`).set(as('agencyFinance')).expect(200);
    await http.get(`/agencies/${agencyId}/officers`).set(as('agencyFinance')).expect(403);
    await http.get(`/agencies/${agencyId}/statements`).set(as('agencyFinance')).expect(404);
    await http.get(`/agencies/${agencyId}/officers`).set(as('head')).expect(404);
  });

  it('dispatcher: the station queue and statements, not its settings', async () => {
    await http.get('/me/station/statements').set(as('dispatcher')).expect(200);
    await http.put('/me/station/areas').set(as('dispatcher')).send({ areas: [{ level: 'district', areaId: 'LA-IKJ-01' }] }).expect(403);
  });

  it('the platform admin adds and removes platform staff; the last admin cannot be removed', async () => {
    const r = (await http.post('/admin/team').set(as('platformAdmin')).send({ phone: '+2348039991001', name: 'New Support', role: 'platform_support' }).expect(201)).body;
    expect(r.message).toMatch(/^Platform support added/);
    await http.post('/admin/team').set(as('platformSupport')).send({ phone: '+2348039991002', name: 'X', role: 'platform_admin' }).expect(403);
    const team = (await http.get('/admin/team').set(as('platformAdmin')).expect(200)).body;
    const member = team.members.find((m: any) => m.name === 'New Support');
    await http.delete(`/admin/team/${member.id}/platform_support`).set(as('platformAdmin')).expect(200);
    await http.delete(`/admin/team/${users.platformAdmin}/platform_admin`).set(as('platformAdmin')).expect(422);
  });
});

describe('agency boards', () => {
  it('officers: list with ratings and rewards; invite a new officer by phone', async () => {
    const o = (await http.get(`/agencies/${agencyId}/officers`).set(as('agencyAdmin')).expect(200)).body;
    expect(o.items.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Insp. Musa Bello', 'Sgt. Bola Ade']));
    const r = (await http.post(`/agencies/${agencyId}/officers/invite`).set(as('agencyAdmin')).send({ name: 'Cpl. Tobi Ade', serviceNo: 'B-1201', phone: '+2348039992001', stationId, role: 'officer' }).expect(201)).body;
    expect(r.message).toMatch(/verifies their identity/);
    const after = (await http.get(`/agencies/${agencyId}/officers`).set(as('agencyAdmin'))).body.items.find((x: any) => x.name === 'Cpl. Tobi Ade');
    expect(after.status).toBe('invited');
    await http.post(`/agencies/${agencyId}/officers/invite`).set(as('agencyAdmin')).send({ name: 'Dup', serviceNo: 'B-1201', phone: '+2348039992002', stationId }).expect(422);
  });

  it('equipment: add a drone with a pilot, mark it for service, and it is billed', async () => {
    await http.post(`/agencies/${agencyId}/equipment`).set(as('agencyAdmin')).send({ kind: 'drone', name: 'Drone, model A', quantity: 1, stationId, pilotName: 'Sgt. Bola Ade' }).expect(201);
    const e = (await http.get(`/agencies/${agencyId}/equipment`).set(as('agencyAdmin')).expect(200)).body;
    expect(e.stats).toMatchObject({ dronesReady: 1, dronePilots: 1 });
    const drone = e.items.find((x: any) => x.name === 'Drone, model A');
    await http.patch(`/agencies/${agencyId}/equipment/${drone.id}`).set(as('agencyAdmin')).send({ status: 'needs_service' }).expect(200);
    expect((await http.get(`/agencies/${agencyId}/equipment`).set(as('agencyAdmin'))).body.stats.needsService).toBeGreaterThanOrEqual(1);
    expect((await http.get(`/agencies/${agencyId}/billing`).set(as('agencyAdmin'))).body.stats.inventoryMonthKobo).toBeGreaterThan(0);
  });

  it('routing rules: a rule for an area, and "test a postcode" shows who gets it', async () => {
    const second = (await db.query(`insert into stations (agency_id, name, status) values ($1, 'Station 9 Yaba', 'active') returning id`, [agencyId])).rows[0].id;
    const before = (await http.post(`/agencies/${agencyId}/routing/test`).set(as('agencyAdmin')).send({ postcode: 'AB12C', type: 'robbery' }).expect(201)).body;
    expect(before).toMatchObject({ first: 'Station 4 Ikeja', why: "The building is inside this station's area." });
    const r = (await http.post(`/agencies/${agencyId}/routing/rules`).set(as('agencyAdmin')).send({ incidentType: 'robbery', areaId: 'LA-IKJ-01', stationId: second, nextStationId: stationId, waitSeconds: 30, priority: 1 }).expect(201)).body;
    const after = (await http.post(`/agencies/${agencyId}/routing/test`).set(as('agencyAdmin')).send({ postcode: 'AB12C', type: 'robbery' })).body;
    expect(after).toMatchObject({ first: 'Station 9 Yaba', then: 'Station 4 Ikeja', why: 'A routing rule covers this area.' });
    await http.post(`/agencies/${agencyId}/routing/rules`).set(as('agencyAdmin')).send({ incidentType: 'robbery', areaId: 'LA-IKJ-01', stationId: second, waitSeconds: 30, priority: 1 }).expect(409);
    // Paused rules are skipped.
    await http.put(`/agencies/${agencyId}/routing/rules/${r.id}`).set(as('agencyAdmin')).send({ incidentType: 'robbery', areaId: 'LA-IKJ-01', stationId: second, nextStationId: stationId, waitSeconds: 30, priority: 1, active: false }).expect(200);
    expect((await http.post(`/agencies/${agencyId}/routing/test`).set(as('agencyAdmin')).send({ postcode: 'AB12C', type: 'robbery' })).body.first).toBe('Station 4 Ikeja');
    await http.post(`/agencies/${agencyId}/routing/rules`).set(as('agencyAdmin')).send({ incidentType: 'fire', stationId, waitSeconds: 30 }).expect(422);
    await http.put(`/agencies/${agencyId}/routing/defaults`).set(as('agencyAdmin')).send({ acceptSeconds: 30, nightHandover: '19:00' }).expect(200);
    expect((await db.query(`select accept_window_seconds from stations where id = $1`, [stationId])).rows[0].accept_window_seconds).toBe(30);
    await db.query(`update stations set status = 'paused' where id = $1`, [second]);
  });

  it('assets: add, import, remote actions need the safety plan and a second admin', async () => {
    const a = (await http.post(`/agencies/${agencyId}/assets`).set(as('agencyAdmin')).send({ kind: 'traffic_light', name: 'Junction 12, Ring Rd', postcode: 'CD34E' }).expect(201)).body;
    const imp = (await http.post(`/agencies/${agencyId}/assets/import`).set(as('agencyAdmin')).send({ csv: 'kind, name, postcode\nstreet light, Light 4 Maple Rd, AB12C\nlamp, Bad line\n' }).expect(201)).body;
    expect(imp).toMatchObject({ added: 1 });
    expect(imp.failed[0].line).toBe(3);
    const list = (await http.get(`/agencies/${agencyId}/assets?tab=traffic_light`).set(as('agencyAdmin')).expect(200)).body;
    expect(list.items.map((x: any) => x.name)).toEqual(['Junction 12, Ring Rd']);
    expect((await http.post(`/agencies/${agencyId}/assets/${a.id}/actions`).set(as('agencyAdmin')).send({ action: 'flashing_amber' }).expect(409)).body.code).toBe('safety_plan');
    await http.patch(`/agencies/${agencyId}/settings`).set(as('agencyAdmin')).send({ safetyPlanSigned: true }).expect(200);
    const asked = (await http.post(`/agencies/${agencyId}/assets/${a.id}/actions`).set(as('agencyAdmin')).send({ action: 'flashing_amber' }).expect(201)).body;
    await http.post(`/agencies/${agencyId}/asset-actions/${asked.id}`).set(as('agencyAdmin')).send({ approve: true }).expect(403);
    const wo = (await http.post(`/agencies/${agencyId}/assets/${a.id}/work-orders`).set(as('agencyAdmin')).send({ kind: 'service' }).expect(201)).body;
    expect(wo.number).toMatch(/^WO-\d{6}$/);
    const d = (await http.get(`/agencies/${agencyId}/assets/${a.id}`).set(as('agencyAdmin')).expect(200)).body;
    expect(d.actions[0]).toMatchObject({ state: 'awaiting_approval', canApprove: false });
    expect(d.workOrders[0].number).toBe(wo.number);
  });

  it('settings: a name change waits for the platform; team invites by role', async () => {
    expect((await http.patch(`/agencies/${agencyId}/settings`).set(as('agencyAdmin')).send({ name: 'Nigeria Police Force, Lagos Command', phone: '+2348011112222' }).expect(200)).body.message).toMatch(/waits for the platform team/);
    const s = (await http.get(`/agencies/${agencyId}/settings`).set(as('agencyFinance')).expect(200)).body;
    expect(s).toMatchObject({ canEdit: false, profile: { phone: '+2348011112222', pending: { name: 'Nigeria Police Force, Lagos Command' } } });
    await http.patch(`/agencies/${agencyId}/settings`).set(as('agencyFinance')).send({ phone: '+2348000000000' }).expect(403);
    await http.post(`/agencies/${agencyId}/team`).set(as('agencyAdmin')).send({ phone: '+2348039993001', name: 'Second Admin', role: 'agency_admin' }).expect(201);
    await http.post(`/agencies/${agencyId}/team`).set(as('agencyAdmin')).send({ phone: '+2348039993002', name: 'Desk', role: 'dispatcher', stationId }).expect(201);
    const after = (await http.get(`/agencies/${agencyId}/settings`).set(as('agencyAdmin'))).body;
    expect(after.team.find((x: any) => x.role === 'dispatcher').n).toBe(2);
    const csv = await http.get(`/agencies/${agencyId}/access-log.csv`).set(as('agencyAdmin')).expect(200);
    expect(csv.text.split('\n')[0]).toBe('Time,What,Who,Item');
  });

  it('a second agency admin approves the remote action', async () => {
    const second = (await db.query(`select id from users where phone = '+2348039993001'`)).rows[0].id;
    t.second = (await http.post('/dev/token').send({ userId: second }).expect(201)).body.token;
    const a = (await db.query(`select id from agency_assets where name = 'Junction 12, Ring Rd'`)).rows[0].id;
    const d = (await http.get(`/agencies/${agencyId}/assets/${a}`).set(as('second')).expect(200)).body;
    expect(d.actions[0].canApprove).toBe(true);
    expect((await http.post(`/agencies/${agencyId}/asset-actions/${d.actions[0].id}`).set(as('second')).send({ approve: true }).expect(201)).body.message).toBe('Set flashing amber sent to Junction 12, Ring Rd.');
  });

  it('station detail: on duty, live reports, area, equipment, devices', async () => {
    const d = (await http.get(`/agencies/${agencyId}/stations/${stationId}/detail`).set(as('agencyAdmin')).expect(200)).body;
    expect(d.name).toBe('Station 4 Ikeja');
    expect(d.areas[0].id).toBe('LA-IKJ-01');
    expect(d.equipment.map((e: any) => e.name)).toContain('Drone, model A');
    expect(d.devices.cameras.total).toBeGreaterThan(0);
    await http.get(`/agencies/${naptipId}/stations/${stationId}/detail`).set(as('agencyAdmin')).expect(404);
  });

  it('messaging: an agency reaches its staff and the people living in its stations’ areas only', async () => {
    const staff = (await http.post(`/agencies/${agencyId}/crm/audience`).set(as('agencyAdmin')).send({ who: ['officer'], kind: 'safety' }).expect(201)).body;
    expect(staff.people).toBeGreaterThanOrEqual(2);
    const citizens = (await http.post(`/agencies/${agencyId}/crm/audience`).set(as('agencyAdmin')).send({ who: ['citizen'], kind: 'safety' }).expect(201)).body;
    expect(citizens.people).toBeGreaterThanOrEqual(2);
    // NAPTIP's stations cover no area, so it reaches no citizens.
    const none = (await http.post(`/agencies/${naptipId}/crm/audience`).set(as('agencyAdmin')).send({ who: ['citizen'], kind: 'safety' }).expect(201)).body;
    expect(none.people).toBe(0);
    const sent = (
      await http
        .post(`/agencies/${agencyId}/crm/campaigns`)
        .set(as('agencyAdmin'))
        .send({ action: 'send', urgent: true, title: 'Road closed', body: 'Allen Avenue is closed tonight.', kind: 'safety', audience: { who: ['citizen'] }, channels: ['push'] })
        .expect(201)
    ).body;
    expect((await http.get(`/agencies/${agencyId}/crm/campaigns`).set(as('agencyAdmin'))).body[0].id).toBe(sent.id);
    await http.get(`/admin/crm/campaigns/${sent.id}`).set(as('platformAdmin')).expect(404);
    await http.get(`/agencies/${naptipId}/crm/campaigns/${sent.id}`).set(as('agencyAdmin')).expect(404);
  });
});
