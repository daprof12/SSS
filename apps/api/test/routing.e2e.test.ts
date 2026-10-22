// Every kind of report reaches the right place: the agency, the station and (for emergencies) the
// officer; the list page each of them works from; and the live maps.
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
let seed: { users: Record<string, string>; agencyId: string; stationId: string; naptipId: string; fermaId: string };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ref = () => `routing-${Date.now()}-${++n}`;
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await fn();
  }
  return v;
}
const live = async (who: string, path: string, kinds: string) => (await http.get(`${path}?kinds=${kinds}`).set(as(who)).expect(200)).body.items as any[];
const DESC = 'Two girls were moved into the blue house at night by a man in a red car.';

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  seed = (await http.post('/dev/seed').expect(201)).body;
  for (const [k, id] of Object.entries(seed.users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [seed.users.officer, 3.352, 6.6015],
    [seed.users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [seed.stationId, u, lng, lat]);
  }
});
afterAll(async () => {
  await app?.close();
});

describe('where each report goes', () => {
  it('an emergency: police, the covering station, the nearest free officer, the station queue and every map', async () => {
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    await waitFor(async () => (await http.get(`/incidents/${id}`).set(as('citizen'))).body, (v: any) => v.state === 'offered');

    const row = (await db.query(`select agency_id, station_id from incidents where id = $1`, [id])).rows[0];
    expect(row).toEqual({ agency_id: seed.agencyId, station_id: seed.stationId });
    const offered = (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows[0].officer_id;
    // The nearest free officer: Insp. Musa Bello is 100 m away, Sgt. Bola Ade about 1.3 km.
    expect(offered).toBe(seed.users.officer);
    expect((await http.get(`/incidents/${id}/offer`).set(as('officer')).expect(200)).body).toMatchObject({ state: 'offered' });

    expect((await http.get('/me/queue').set(as('head')).expect(200)).body.map((r: any) => r.id)).toContain(id);
    expect((await http.get('/me/station/map').set(as('head')).expect(200)).body.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ id, type: 'robbery', lat: expect.any(Number) })]));
    const agencyMap = await live('agencyAdmin', `/agencies/${seed.agencyId}/live`, 'emergency');
    expect(agencyMap.find((x) => x.id === id)).toMatchObject({ kind: 'emergency', type: 'robbery', href: `/incidents/${id}`, line: expect.stringContaining('Station 4 Ikeja') });
    expect((await live('platformAdmin', '/admin/live', 'emergency')).some((x) => x.id === id)).toBe(true);
    // Other agencies do not see it.
    expect((await live('naptipAdmin', `/agencies/${seed.naptipId}/live`, 'emergency')).some((x) => x.id === id)).toBe(false);
  });

  it('a tip: the agency for its category, the station covering the place, the tips queue and the maps', async () => {
    const tip = (await http.post('/tips').set(as('citizen')).send({ category: 'human_trafficking', description: DESC, anonymous: true, clientRef: ref(), postcode: 'CD34E' }).expect(201)).body;
    expect(tip.routedTo).toBe('NAPTIP (demo)');
    const queue = (await http.get(`/agencies/${seed.naptipId}/tips?tab=new`).set(as('naptipAdmin')).expect(200)).body;
    expect(queue.find((x: any) => x.id === tip.id)).toMatchObject({ category: 'Human trafficking', station: null });
    expect((await live('naptipAdmin', `/agencies/${seed.naptipId}/live`, 'tip')).find((x) => x.id === tip.id)).toMatchObject({ kind: 'tip', lat: expect.any(Number), href: `/agency/tips/${tip.id}` });
    expect((await live('platformAdmin', '/admin/live', 'tip')).some((x) => x.id === tip.id)).toBe(true);
    await http.get(`/agencies/${seed.agencyId}/tips/${tip.id}`).set(as('agencyAdmin')).expect(404);

    // A tip for the police goes to the police station for the place.
    const cult = (await http.post('/tips').set(as('citizen')).send({ category: 'cult_activity', description: DESC, anonymous: false, clientRef: ref(), postcode: 'CD34E' }).expect(201)).body;
    expect(cult.routedTo).toBe((await db.query(`select name from agencies where id = $1`, [seed.agencyId])).rows[0].name);
    const police = (await http.get(`/agencies/${seed.agencyId}/tips?tab=new`).set(as('agencyAdmin')).expect(200)).body;
    expect(police.find((x: any) => x.id === cult.id)).toMatchObject({ station: 'Station 4 Ikeja' });
  });

  it('a tip goes to the agency whose station covers the place, not just the first one that joined', async () => {
    const lga = (await db.query(`select lga_id from locations where postcode = 'CD34E'`)).rows[0].lga_id;
    const ag = (await db.query(`insert into agencies (name, kind, status, period_start, period_end) values ('NAPTIP Lagos Zone (test)', 'naptip', 'live', current_date, current_date + 30) returning id`)).rows[0].id;
    const st = (await db.query(`insert into stations (agency_id, name, status) values ($1, 'NAPTIP Ikeja Office', 'active') returning id`, [ag])).rows[0].id;
    await db.query(`insert into station_areas (station_id, level, area_id, label) values ($1, 'lga', $2, 'Ikeja')`, [st, lga]);
    const tip = (await http.post('/tips').set(as('neighbour')).send({ category: 'human_trafficking', description: DESC, anonymous: true, clientRef: ref(), postcode: 'CD34E' }).expect(201)).body;
    expect(tip.routedTo).toBe('NAPTIP Lagos Zone (test)');
    expect((await db.query(`select agency_id, station_id from tips where id = $1`, [tip.id])).rows[0]).toEqual({ agency_id: ag, station_id: st });
    // Without a place it still reaches an agency of the right kind.
    const nowhere = (await http.post('/tips').set(as('neighbour')).send({ category: 'human_trafficking', description: DESC, anonymous: true, clientRef: ref() }).expect(201)).body;
    expect(['NAPTIP (demo)', 'NAPTIP Lagos Zone (test)']).toContain(nowhere.routedTo);
    await db.query(`update agencies set status = 'offboarded' where id = $1`, [ag]);
  });

  it('a public issue: the agency for its category, the issues queue and the maps', async () => {
    const r = (await http.post('/issues').set(as('citizen')).send({ category: 'road', subtype: 'Pothole', severity: 'dangerous', description: 'Deep pothole by the bus stop', clientRef: ref(), postcode: 'GH78J' }).expect(201)).body;
    const caseId = r.caseId ?? r.id;
    expect((await db.query(`select agency_id from issue_cases where id = $1`, [caseId])).rows[0].agency_id).toBe(seed.fermaId);
    const queue = (await http.get(`/agencies/${seed.fermaId}/issues`).set(as('fermaAdmin')).expect(200)).body;
    expect(queue.find((x: any) => x.id === caseId)).toMatchObject({ category: 'Bad road or pothole' });
    expect((await live('fermaAdmin', `/agencies/${seed.fermaId}/live`, 'issue')).find((x) => x.id === caseId)).toMatchObject({ kind: 'issue', lat: expect.any(Number), href: `/agency/issues/${caseId}` });
    expect((await live('platformAdmin', '/admin/live', 'issue')).some((x) => x.id === caseId)).toBe(true);
    await http.get(`/agencies/${seed.agencyId}/issues/${caseId}`).set(as('agencyAdmin')).expect(404);
  });

  it('date range on the queues', async () => {
    const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
    expect((await http.get(`/agencies/${seed.fermaId}/issues?from=${today}&to=${today}`).set(as('fermaAdmin')).expect(200)).body.length).toBeGreaterThan(0);
    expect((await http.get(`/agencies/${seed.fermaId}/issues?from=2020-01-01&to=2020-01-31`).set(as('fermaAdmin')).expect(200)).body).toEqual([]);
    expect((await http.get(`/agencies/${seed.naptipId}/tips?tab=new&from=2020-01-01&to=2020-01-31`).set(as('naptipAdmin')).expect(200)).body).toEqual([]);
    await http.get(`/agencies/${seed.fermaId}/issues?from=2026-02-10&to=2026-02-01`).set(as('fermaAdmin')).expect(400);
  });

  it('ratings agree on every page, and count only reports the officer took', async () => {
    // Officer 2 is offered a report and declines; officer 1 takes it, closes it, and is rated 4 stars.
    // Free both officers from the earlier report first.
    await db.query(`update incident_units set state = 'released' where state in ('offered', 'accepted', 'en_route', 'on_scene')`);
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'riot', postcode: 'GH78J', clientRef: ref() }).expect(201)).body.id;
    await waitFor(async () => (await http.get(`/incidents/${id}`).set(as('citizen'))).body, (v: any) => v.state === 'offered');
    let who = (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows[0].officer_id;
    if (who === seed.users.officer2) {
      await http.post(`/incidents/${id}/decline`).set(as('officer2')).send({ reason: 'busy' }).expect(201);
      who = (await waitFor(async () => (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows[0], (x) => !!x)).officer_id;
    } else {
      await db.query(`insert into incident_units (incident_id, station_id, officer_id, role, state, decline_reason) values ($1, $2, $3, 'primary', 'declined', 'busy')`, [id, seed.stationId, seed.users.officer2]);
    }
    expect(who).toBe(seed.users.officer);
    for (const event of ['accept', 'start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event }).expect(201);
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'close_valid', outcomeCode: 'arrest' }).expect(201);
    await http.post(`/incidents/${id}/rating`).set(as('citizen')).send({ stars: 4, tags: ['fast', 'solved'] }).expect(201);

    const profile = (await http.get('/me/officer/profile').set(as('officer')).expect(200)).body.rating;
    expect(profile).toMatchObject({ overall: 4, count: 1, solved: 4.5 });
    expect((await http.get(`/incidents/${id}`).set(as('citizen')).expect(200)).body.officer.rating).toBe(4);
    const team = (await http.get('/me/station/team').set(as('head')).expect(200)).body;
    expect(team.officers.find((o: any) => o.id === seed.users.officer).rating).toBe(4);
    expect(team.officers.find((o: any) => o.id === seed.users.officer2).rating).toBeNull();
    expect(team.stats.rating).toBe(4);
    const agency = (await http.get(`/agencies/${seed.agencyId}/officers`).set(as('agencyAdmin')).expect(200)).body.items;
    expect(agency.find((o: any) => o.id === seed.users.officer).rating).toBe(4);
    // Declining an offer never earns the rating of the report someone else took.
    expect(agency.find((o: any) => o.id === seed.users.officer2).rating).toBeNull();
    expect((await http.get('/me/officer/profile').set(as('officer2')).expect(200)).body.rating.overall).toBeNull();
  });
});
