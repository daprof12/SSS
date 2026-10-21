// Jurisdiction routing, and the platform admin boards: coverage map, device wall, inventory,
// agencies and stations, donations, audit log, AI and LLM, CRM messaging.
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
const ref = () => `adm-${Date.now()}-${++n}`;

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
});
afterAll(async () => {
  await app?.close();
});

/** Reports a robbery at a postcode and returns the station it was offered to. */
const report = async (postcode: string) => {
  await db.query(`update incidents set state = 'cancelled' where state not in ('resolved', 'unfounded', 'cancelled', 'merged')`);
  const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode, clientRef: ref() }).expect(201)).body.id;
  let row: { state: string; station_id: string } | undefined;
  for (let i = 0; i < 100; i++) {
    row = (await db.query(`select state, station_id from incidents where id = $1`, [id])).rows[0];
    if (row?.state === 'offered') break;
    await sleep(50);
  }
  return { id, stationId: row!.station_id, state: row!.state };
};

describe('jurisdiction routing', () => {
  let yaba = '';
  let yabaOfficer = '';
  beforeAll(async () => {
    // A second police station with no building of its own (so distance cannot pick it) that covers Yaba.
    yaba = (await db.query(`insert into stations (agency_id, name, status) values ($1, 'Station 9 Yaba', 'active') returning id`, [agencyId])).rows[0].id;
    await db.query(`insert into station_areas (station_id, level, area_id, label) values ($1, 'district', 'LA-YAB-02', 'Yaba')`, [yaba]);
    yabaOfficer = (await db.query(`insert into users (phone, display_name) values ('+2348031110001', 'Yaba Officer') returning id`)).rows[0].id;
    await db.query(
      `insert into officers (user_id, station_id, badge_no, badge_status, on_duty, last_location) values ($1, $2, 'Y-001', 'verified', true, st_setsrid(st_makepoint(3.3711, 6.5095), 4326)::geography)`,
      [yabaOfficer, yaba],
    );
    await db.query(`insert into user_roles (user_id, role, scope_type, scope_id) values ($1, 'officer', 'station', $2)`, [yabaOfficer, yaba]);
  });

  it('a report goes to the station whose area covers it, and its officer gets the offer', async () => {
    const r = await report('EF56G');
    expect(r.stationId).toBe(yaba);
    const unit = (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [r.id])).rows[0];
    expect(unit.officer_id).toBe(yabaOfficer);
    expect((await report('AB12C')).stationId).toBe(stationId);
  });

  it('a routing rule for the area wins over the covering station', async () => {
    await db.query(`insert into routing_rules (incident_type, area_id, station_id, priority) values ('robbery', 'LA-IKJ-01', $1, 1)`, [yaba]);
    expect((await report('AB12C')).stationId).toBe(yaba);
    await db.query(`delete from routing_rules`);
  });

  it('outside every area: the nearest station, marked as outside its area', async () => {
    const r = await report('GH78J');
    expect(r.stationId).toBe(stationId);
    const e = (await db.query(`select payload from incident_events where incident_id = $1 and kind = 'outside_area'`, [r.id])).rows[0];
    expect(e.payload.stationId).toBe(stationId);
  });

  it('when nobody at the covering station is free, it overflows to the next station', async () => {
    await db.query(`update officers set on_duty = false where user_id = $1`, [yabaOfficer]);
    expect((await report('EF56G')).stationId).toBe(stationId);
    await db.query(`update officers set on_duty = true where user_id = $1`, [yabaOfficer]);
  });

  it('the station head sets the area; only the head can', async () => {
    const body = { areas: [{ level: 'district', areaId: 'LA-IKJ-01', label: 'Ikeja GRA' }, { level: 'lga', areaId: 'LA-ETI', label: 'Eti-Osa' }] };
    await http.put('/me/station/areas').set(as('officer')).send(body).expect(403);
    expect((await http.put('/me/station/areas').set(as('head')).send(body).expect(200)).body.message).toMatch(/come to this station first/);
    const s = (await http.get('/me/station/settings').set(as('head')).expect(200)).body;
    expect(s.areas.map((a: any) => a.label).sort()).toEqual(['Eti-Osa', 'Ikeja GRA']);
    // Victoria Island is in Eti-Osa, so it is no longer outside the area.
    const r = await report('GH78J');
    expect((await db.query(`select 1 from incident_events where incident_id = $1 and kind = 'outside_area'`, [r.id])).rowCount).toBe(0);
    await db.query(`update stations set status = 'paused' where id = $1`, [yaba]);
    await db.query(`update incidents set state = 'cancelled' where state not in ('resolved', 'unfounded', 'cancelled', 'merged')`);
  });
});

describe('coverage map and device wall', () => {
  let camera = '';
  let light = '';
  let household = '';
  it('counts devices by status, filters by place and type', async () => {
    const c = (await http.get('/admin/coverage').set(as('platformAdmin')).expect(200)).body;
    expect(c.devices.length).toBeGreaterThan(0);
    expect(Object.keys(c.stats)).toEqual(expect.arrayContaining(['online', 'low_power', 'offline', 'needs_repair', 'tamper', 'notCovered']));
    camera = c.devices.find((d: any) => d.type === 'camera').id;
    light = c.devices.find((d: any) => d.type === 'street_light').id;
    household = c.devices.find((d: any) => d.type === 'camera').householdId;
    expect((await http.get('/admin/coverage?type=camera').set(as('platformAdmin'))).body.devices.every((d: any) => d.type === 'camera')).toBe(true);
    expect((await http.get('/admin/coverage?state=FC').set(as('platformAdmin'))).body.devices).toEqual([]);
    expect((await http.get('/admin/coverage?postcode=AB12').set(as('platformAdmin'))).body.devices.length).toBeGreaterThan(0);
    await http.get('/admin/coverage').set(as('citizen')).expect(403);
  });

  it('sends a technician once, and alerts the station that covers the device', async () => {
    const r = (await http.post(`/admin/devices/${camera}/technician`).set(as('platformAdmin')).send({ note: 'Tamper check' }).expect(201)).body;
    expect(r.number).toMatch(/^RP-\d{6}$/);
    await http.post(`/admin/devices/${camera}/technician`).set(as('platformAdmin')).send({}).expect(409);
    expect((await http.post(`/admin/devices/${camera}/alert-station`).set(as('platformAdmin')).expect(201)).body.message).toBe('Station 4 Ikeja was alerted.');
    const note = (await http.get('/me/notifications').set(as('head'))).body.items.find((x: any) => x.type === 'device_tamper');
    expect(note).toBeTruthy();
  });

  it('device wall: tiles, households, and the modal', async () => {
    const w = (await http.get('/admin/device-wall?tab=cameras').set(as('platformAdmin')).expect(200)).body;
    expect(w.tiles.every((d: any) => d.type === 'camera')).toBe(true);
    expect(w.households.find((h: any) => h.id === household).postcode).toBe('AB12C');
    const h = (await http.get(`/admin/households/${household}`).set(as('platformAdmin')).expect(200)).body;
    expect(h.devices.map((d: any) => d.type)).toEqual(expect.arrayContaining(['camera', 'street_light']));
  });

  it('a live view needs a reason, which is logged with the name and shown to the owner', async () => {
    const online = (await db.query(`update devices set status = 'online' where id = $1 returning id`, [camera])).rows[0].id;
    expect((await http.post(`/admin/devices/${online}/live`).set(as('platformAdmin')).send({ reason: '' }).expect(422)).body.message).toBe('A reason is required. It is logged with your name.');
    expect((await http.post(`/admin/devices/${online}/live`).set(as('platformAdmin')).send({ reason: 'Repair visit check' }).expect(201)).body.mode).toBe('test');
    const log = (await db.query(`select reason, via, actor_role from camera_access_log where device_id = $1 order by id desc limit 1`, [online])).rows[0];
    expect(log).toEqual({ reason: 'Repair visit check', via: 'dashboard', actor_role: 'platform_admin' });
    await db.query(`update devices set status = 'online' where id = $1`, [light]);
    expect((await http.post(`/admin/devices/${light}/light`).set(as('platformAdmin')).send({ action: 'on' }).expect(201)).body.message).toBe('On for the next hour.');
  });

  it('schedules a visit and tells the owner', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await http.post(`/admin/households/${household}/visit`).set(as('platformAdmin')).send({ date: '2020-01-01', window: 'morning' }).expect(422);
    expect((await http.post(`/admin/households/${household}/visit`).set(as('platformAdmin')).send({ date: tomorrow, window: 'afternoon' }).expect(201)).body.message).toMatch(/1pm to 5pm\. The owner was told\.$/);
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.some((x: any) => x.type === 'visit_booked')).toBe(true);
  });
});

describe('inventory, agencies, donations', () => {
  it('adds stock, moves it between stores, refuses moving more than is there', async () => {
    const inv = (await http.get('/admin/inventory').set(as('platformAdmin')).expect(200)).body;
    const ikeja = inv.stores.find((s: any) => s.name === 'Ikeja store');
    const yaba = inv.stores.find((s: any) => s.name === 'Yaba store');
    expect(ikeja.stock.camera.quantity).toBe(24);
    await http.post('/admin/inventory/stock').set(as('platformAdmin')).send({ storeId: ikeja.id, item: 'camera', quantity: 6 }).expect(201);
    expect((await http.post('/admin/inventory/transfer').set(as('platformAdmin')).send({ from: ikeja.id, to: yaba.id, item: 'camera', quantity: 10 }).expect(201)).body.message).toBe('Moved 10 cameras to Yaba store.');
    expect((await http.post('/admin/inventory/transfer').set(as('platformAdmin')).send({ from: yaba.id, to: ikeja.id, item: 'pole', quantity: 50 }).expect(409)).body.message).toBe('Only 2 in that store.');
    const after = (await http.get('/admin/inventory?lga=LA-YAB').set(as('platformAdmin'))).body;
    expect(after.stores.map((s: any) => s.name)).toEqual(['Yaba store']);
    expect(after.stores[0].stock.camera.quantity).toBe(18);
    expect(after.moves[0]).toMatchObject({ item: 'Cameras', quantity: 10, from: 'Ikeja store', to: 'Yaba store' });
  });

  it('agencies and stations, with the area each station covers', async () => {
    const b = (await http.get('/admin/agencies-board?kind=police').set(as('platformAdmin')).expect(200)).body;
    expect(b.agencies.every((a: any) => a.kind === 'Police')).toBe(true);
    expect(b.stations.find((s: any) => s.id === stationId).areas).toContain('Ikeja GRA');
    expect((await http.get('/admin/agencies-board?lga=LA-IKJ').set(as('platformAdmin'))).body.stations.map((s: any) => s.name)).toEqual(['Station 4 Ikeja']);
  });

  it('donations list by receiving station place, and the payout run pays the queue', async () => {
    const pay = (await db.query(`insert into payments (user_id, purpose, amount_kobo, provider_ref, idempotency_key, state) values ($1, 'donation', 100000, $2, $2, 'succeeded') returning id`, [users.citizen, ref()])).rows[0].id;
    await db.query(`insert into donations (donor_id, target_type, target_id, amount_kobo, payment_id, state, paid_at, method) values ($1, 'station', $2, 100000, $3, 'paid', now(), 'card')`, [users.citizen, stationId, pay]);
    const d = (await http.get('/admin/donations?lga=LA-IKJ').set(as('platformAdmin')).expect(200)).body;
    expect(d.donations[0]).toMatchObject({ donor: 'Anonymous', recipient: 'Station 4 Ikeja', level: 'Station', payout: 'queued', netKobo: 70000 });
    expect(d.stats).toMatchObject({ donatedMonthKobo: 100000, waitingKobo: 70000, feePct: 30 });
    expect((await http.get('/admin/donations?lga=LA-YAB').set(as('platformAdmin'))).body.donations).toEqual([]);
    expect((await http.post('/admin/donations/payout').set(as('platformAdmin')).expect(201)).body.count).toBe(1);
    expect((await http.get('/admin/donations').set(as('platformAdmin'))).body.donations[0].payout).toBe('paid');
  });
});

describe('audit log', () => {
  it('records refused attempts; entries are filtered, chained and exportable', async () => {
    await http.get('/admin/audit').set(as('citizen')).expect(403);
    const log = (await http.get('/admin/audit?days=1').set(as('platformAdmin')).expect(200)).body;
    expect(log.stats.refused).toBeGreaterThan(0);
    expect(log.stats.liveViews).toBe(1);
    const live = log.entries.find((e: any) => e.code === 'device.live_view');
    expect(live).toMatchObject({ action: 'Opened a live camera view. Reason: Repair visit check', postcode: 'AB12C', result: 'Allowed', role: 'Platform admin' });
    const refused = (await http.get('/admin/audit?action=refused').set(as('platformAdmin'))).body.entries;
    expect(refused.every((e: any) => e.result === 'Refused')).toBe(true);
    expect((await http.get('/admin/audit?postcode=AB12').set(as('platformAdmin'))).body.entries.every((e: any) => e.postcode?.startsWith('AB12'))).toBe(true);
    const entry = (await http.get(`/admin/audit/${live.id}`).set(as('platformAdmin')).expect(200)).body;
    expect(entry.intact).toBe(true);
    expect(entry.reason).toBe('Repair visit check');
    const csv = await http.get('/admin/audit.csv?days=1').set(as('platformAdmin')).expect(200);
    expect(csv.text.split('\n')[0]).toBe('Entry,Time,Person,Role,Action,Postcode,Result');
  });
});

describe('AI and LLM', () => {
  let statementId = '';
  it('overview: use cases, settings, languages, usage', async () => {
    const a = (await http.get('/admin/ai').set(as('platformAdmin')).expect(200)).body;
    expect(a.useCases.map((u: any) => u.code)).toContain('translate');
    expect(a.settings.reviewBelowPct).toBe(80);
    expect(a.perDay).toHaveLength(14);
  });

  it('a low-confidence signed translation waits for review; a note is required to act', async () => {
    const inc = (await db.query(`select id from incidents order by created_at desc limit 1`)).rows[0].id;
    statementId = (
      await db.query(
        `insert into statements (number, incident_id, citizen_id, station_id, requested_by, state) values ('ST-900001', $1, $2, $3, $4, 'signed') returning id`,
        [inc, users.citizen, stationId, users.head],
      )
    ).rows[0].id;
    await db.query(
      `insert into statement_versions (statement_id, version, language, original_text, english_text, ai_confidence, flagged_words, signed_with, seal)
       values ($1, 1, 'ha', 'Barayi sun zo Maple Road da 10:30', '[Machine draft] Robbers came to Maple Road at 10:30', 0.62, '{Maple,Road,10:30}', 'pin', 'x')`,
      [statementId],
    );
    const q = (await http.get('/admin/ai/reviews').set(as('platformAdmin')).expect(200)).body;
    expect(q[0]).toMatchObject({ statementId, language: 'Hausa', confidencePct: 62, flagged: 3 });
    const r = (await http.get(`/admin/ai/reviews/${statementId}`).set(as('platformAdmin')).expect(200)).body;
    expect(r).toMatchObject({ thresholdPct: 80, cause: 'Place names and numbers', status: 'Signed by reporter' });
    expect((await http.post(`/admin/ai/reviews/${statementId}`).set(as('platformAdmin')).send({ decision: 'rerecord' }).expect(422)).body.message).toBe('A note is required.');
    await http.post(`/admin/ai/reviews/${statementId}`).set(as('platformAdmin')).send({ decision: 'rerecord', note: 'The street name is unclear.' }).expect(201);
    expect((await db.query(`select state from statements where id = $1`, [statementId])).rows[0].state).toBe('change_requested');
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.some((x: any) => x.type === 'statement_change')).toBe(true);
    await http.post(`/admin/ai/reviews/${statementId}`).set(as('platformAdmin')).send({ decision: 'looks_right' }).expect(409);
    expect((await http.get('/admin/ai/reviews').set(as('platformAdmin'))).body).toEqual([]);
  });

  it('pausing translation keeps the words and waits for a person', async () => {
    await http.post('/admin/ai/switch').set(as('platformAdmin')).send({ translationPaused: true }).expect(201);
    const s = (await http.put(`/me/statements/${statementId}/draft`).set(as('citizen')).send({ language: 'ha', original: 'Barayi sun zo gidan mu da dare' }).expect(200)).body;
    expect(s.draft).toMatchObject({ original: 'Barayi sun zo gidan mu da dare', english: '', confidence: null });
    expect((await http.get('/admin/ai').set(as('platformAdmin'))).body.useCases.find((u: any) => u.code === 'translate').status).toBe('paused');
    await http.post('/admin/ai/switch').set(as('platformAdmin')).send({ translationPaused: false }).expect(201);
  });
});

describe('CRM messaging', () => {
  it('sizes the audience by role and place, and checks the SMS length', async () => {
    const a = (await http.post('/admin/crm/audience').set(as('platformAdmin')).send({ who: ['citizen'], lga: 'LA-IKJ' }).expect(201)).body;
    expect(a.people).toBeGreaterThanOrEqual(2);
    expect((await http.post('/admin/crm/audience').set(as('platformAdmin')).send({ who: ['citizen'], lga: 'LA-YAB' })).body.people).toBe(0);
    const long = 'x'.repeat(170);
    const e = (await http.post('/admin/crm/campaigns').set(as('platformAdmin')).send({ action: 'send', title: 'Road works', body: long, kind: 'safety', audience: { who: ['citizen'] }, channels: ['push', 'sms'] }).expect(422)).body;
    expect(e.message).toBe('SMS must be 160 characters or fewer, now 10 over.');
  });

  it('sends: push to people with the app, SMS to the rest; results by channel', async () => {
    const sent = (
      await http
        .post('/admin/crm/campaigns')
        .set(as('platformAdmin'))
        .send({ action: 'send', urgent: true, title: 'Road works on Maple Road', body: 'Maple Road is closed until Friday.', kind: 'safety', audience: { who: ['citizen'], district: 'LA-IKJ-01' }, channels: ['push', 'sms'] })
        .expect(201)
    ).body;
    expect(sent.state).toBe('sent');
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.some((x: any) => x.title === 'Road works on Maple Road')).toBe(true);
    const c = (await http.get(`/admin/crm/campaigns/${sent.id}`).set(as('platformAdmin')).expect(200)).body;
    expect(c.stats.people).toBeGreaterThanOrEqual(2);
    expect(c.stats.reachedPct).toBe(100);
    expect(c.channelsTable.map((r: any) => r.channel)).toEqual(['Push', 'SMS', 'WhatsApp']);
    expect((await http.get('/admin/crm/campaigns').set(as('platformAdmin'))).body[0].id).toBe(sent.id);
    const dup = (await http.post(`/admin/crm/campaigns/${sent.id}/duplicate`).set(as('platformAdmin')).expect(201)).body;
    expect((await http.get(`/admin/crm/campaigns/${dup.id}`).set(as('platformAdmin'))).body.state).toBe('draft');
  });

  it('a campaign sent for approval needs a different admin', async () => {
    const r = (
      await http
        .post('/admin/crm/campaigns')
        .set(as('platformAdmin'))
        .send({ action: 'request_approval', title: 'New feature', body: 'Try the Learn feed.', kind: 'marketing', audience: { who: ['citizen'] }, channels: ['push'] })
        .expect(201)
    ).body;
    expect(r.state).toBe('awaiting_approval');
    await http.post(`/admin/crm/campaigns/${r.id}/approve`).set(as('platformAdmin')).expect(403);
    const admin2 = (await db.query(`insert into users (phone, display_name) values ('+2348039990002', 'Second Admin') returning id`)).rows[0].id;
    await db.query(`insert into user_roles (user_id, role, scope_type) values ($1, 'platform_admin', 'platform')`, [admin2]);
    t.admin2 = (await http.post('/dev/token').send({ userId: admin2 }).expect(201)).body.token;
    expect((await http.post(`/admin/crm/campaigns/${r.id}/approve`).set(as('admin2')).expect(201)).body.message).toMatch(/^Approved and sent to \d+ people\.$/);
    const c = (await http.get(`/admin/crm/campaigns/${r.id}`).set(as('platformAdmin'))).body;
    expect(c.approvedBy.name).toBe('Second Admin');
  });
});

describe('location filter on the older admin pages', () => {
  it('fines, KYC, repairs, installs, help inbox and subscription stats follow the place', async () => {
    for (const path of ['/admin/fines?status=all', '/admin/kyc', '/admin/repairs', '/admin/installs', '/admin/support?status=all', '/admin/subscriptions']) {
      const sep = path.includes('?') ? '&' : '?';
      await http.get(`${path}${sep}lga=LA-IKJ`).set(as('platformAdmin')).expect(200);
      const far = (await http.get(`${path}${sep}state=FC`).set(as('platformAdmin')).expect(200)).body;
      const items = Array.isArray(far) ? far : far.items;
      expect(items).toEqual([]);
    }
    const repairs = (await http.get('/admin/repairs?postcode=AB12C').set(as('platformAdmin'))).body.items;
    expect(repairs.length).toBeGreaterThan(0);
    expect((await http.get('/admin/subscriptions?state=FC').set(as('platformAdmin'))).body.stats.active).toBe(0);
  });
});
