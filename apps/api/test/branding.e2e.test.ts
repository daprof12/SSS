// Agency logos (upload, public image, who sees it) and donations seen by the agency and by the platform.
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
// A 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

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

describe('agency logo', () => {
  it('lets the agency admin upload one; only images; not other agencies or officers', async () => {
    const put = (who: string, body: Buffer, agency = seed.agencyId) => http.put(`/agencies/${agency}/logo`).set(as(who)).set('Content-Type', 'image/png').send(body);
    expect((await put('agencyAdmin', Buffer.from('<svg onload=alert(1)>')).expect(422)).body.message).toBe('Use a PNG, JPEG or WebP image.');
    await put('officer', PNG).expect(404);
    await put('naptipAdmin', PNG).expect(404);
    await put('agencyAdmin', Buffer.alloc(600 * 1024, 1)).expect(413);
    const r = (await put('agencyAdmin', PNG).expect(200)).body;
    expect(r.logoUrl).toMatch(new RegExp(`^/agencies/${seed.agencyId}/logo\\?v=[0-9a-f]{12}$`));

    // Anyone can load it, typed by its real bytes.
    const img = await http.get(`/agencies/${seed.agencyId}/logo`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body).equals(PNG)).toBe(true);
    await http.get(`/agencies/${seed.agencyId}/logo`).set('If-None-Match', img.headers.etag).expect(304);
    await http.get(`/agencies/${seed.naptipId}/logo`).expect(404);
    expect((await db.query(`select action from audit_log where entity_id = $1 and action like 'agency.logo%'`, [seed.agencyId])).rows.map((x) => x.action)).toEqual(['agency.logo_set']);
  });

  it('shows on the agency, its stations and its officers', async () => {
    const me = async (who: string) => (await http.get('/me').set(as(who)).expect(200)).body.brand;
    const logo = expect.stringMatching(/^\/agencies\/.+\/logo\?v=/);
    expect(await me('agencyAdmin')).toMatchObject({ agencyId: seed.agencyId, stationName: null, logoUrl: logo });
    expect(await me('head')).toMatchObject({ agencyId: seed.agencyId, stationName: 'Station 4 Ikeja', logoUrl: logo });
    expect(await me('dispatcher')).toMatchObject({ stationName: 'Station 4 Ikeja', logoUrl: logo });
    expect(await me('officer')).toMatchObject({ agencyId: seed.agencyId, stationName: 'Station 4 Ikeja', logoUrl: logo });
    expect(await me('naptipAdmin')).toMatchObject({ agencyId: seed.naptipId, logoUrl: null });
    expect(await me('citizen')).toBeNull();
    expect((await http.get('/me/agencies').set(as('agencyAdmin')).expect(200)).body[0].logoUrl).toMatch(/logo\?v=/);

    await http.delete(`/agencies/${seed.agencyId}/logo`).set(as('agencyAdmin')).expect(200);
    expect((await me('officer')).logoUrl).toBeNull();
  });
});

describe('donations by agency', () => {
  it('shows an agency the gifts to it, its stations and its officers; the platform sees each agency apart', async () => {
    const gift = (type: string, target: string, kobo: number, show = true) =>
      db.query(`insert into donations (donor_id, target_type, target_id, amount_kobo, show_name, state, method, paid_at) values ($1, $2, $3, $4, $5, 'paid', 'wallet', now())`, [seed.users.citizen, type, target, kobo, show]);
    await gift('station', seed.stationId, 500_000);
    await gift('officer', seed.users.officer, 200_000, false);
    await gift('agency', seed.agencyId, 1_000_000);
    await gift('agency', seed.naptipId, 300_000);

    const police = (await http.get(`/agencies/${seed.agencyId}/donations`).set(as('agencyAdmin')).expect(200)).body;
    expect(police.totals).toMatchObject({ gifts: 3, kobo: 1_700_000, agencyKobo: 1_000_000, stationsKobo: 500_000, officersKobo: 200_000 });
    expect(police.items.map((x: any) => x.recipient).sort()).toEqual(['Insp. Musa Bello', 'Nigeria Police Force (demo)', 'Station 4 Ikeja']);
    expect(police.items.find((x: any) => x.level === 'officer')).toMatchObject({ donor: 'Anonymous', station: 'Station 4 Ikeja' });
    expect((await http.get(`/agencies/${seed.agencyId}/donations?level=station`).set(as('agencyAdmin')).expect(200)).body.items).toHaveLength(1);
    expect((await http.get(`/agencies/${seed.agencyId}/donations?from=2020-01-01&to=2020-01-31`).set(as('agencyAdmin')).expect(200)).body.totals.gifts).toBe(0);
    expect((await http.get(`/agencies/${seed.agencyId}/donations`).set(as('agencyFinance')).expect(200)).body.totals.gifts).toBe(3);
    await http.get(`/agencies/${seed.agencyId}/donations`).set(as('naptipAdmin')).expect(404);
    expect((await http.get(`/agencies/${seed.naptipId}/donations`).set(as('naptipAdmin')).expect(200)).body.totals).toMatchObject({ gifts: 1, kobo: 300_000 });

    const all = (await http.get('/admin/donations').set(as('platformAdmin')).expect(200)).body;
    expect(all.byAgency.find((a: any) => a.id === seed.agencyId)).toMatchObject({ gifts: 3, kobo: 1_700_000, officersKobo: 200_000 });
    expect(all.byAgency.find((a: any) => a.id === seed.naptipId)).toMatchObject({ gifts: 1, kobo: 300_000 });
    expect(all.donations.find((d: any) => d.level === 'Officer')).toMatchObject({ agency: expect.stringMatching(/Police/), agencyId: seed.agencyId });
    const naptip = (await http.get(`/admin/donations?agencyId=${seed.naptipId}`).set(as('platformAdmin')).expect(200)).body;
    expect(naptip.donations).toHaveLength(1);
    expect((await http.get(`/admin/donations?level=station`).set(as('platformAdmin')).expect(200)).body.donations.every((d: any) => d.level === 'Station')).toBe(true);
  });

  it('shows the station head the gifts to the station and its officers, and the rewards its officers earned; read only', async () => {
    const own = (await http.get('/me/station/donations').set(as('head')).expect(200)).body;
    expect(own.totals).toMatchObject({ gifts: 2, kobo: 700_000, stationsKobo: 500_000, officersKobo: 200_000, agencyKobo: 0 });
    expect(own.items.map((x: any) => x.recipient).sort()).toEqual(['Insp. Musa Bello', 'Station 4 Ikeja']);
    expect((await http.get('/me/station/donations?level=officer').set(as('head')).expect(200)).body.items).toHaveLength(1);

    // A paid reward on one of the station's reports.
    const inc = (await db.query(`select id from incidents where station_id = $1 limit 1`, [seed.stationId])).rows[0]?.id
      ?? (await db.query(`insert into incidents (type, state, station_id, agency_id, reporter_id, geom) values ('robbery', 'received', $1, $2, $3, st_setsrid(st_makepoint(3.35, 6.6), 4326)::geography) returning id`, [seed.stationId, seed.agencyId, seed.users.citizen])).rows[0].id;
    await db.query(`insert into reward_payments (incident_id, agency_id, stars, total_kobo, state, shares) values ($1, $2, 5, 500000, 'paid', $3)`, [inc, seed.agencyId, JSON.stringify([{ id: seed.users.officer, kobo: 500000 }])]);
    const pay = (await http.get('/me/station/payouts').set(as('head')).expect(200)).body;
    expect(pay).toMatchObject({ station: 'Station 4 Ikeja', totals: { kobo: 500_000, paid: 1, skipped: 0 } });
    expect(pay.officers.find((o: any) => o.id === seed.users.officer)).toMatchObject({ kobo: 500_000, responses: 1 });
    expect(pay.recent[0]).toMatchObject({ stars: 5, state: 'paid', officers: [{ name: 'Insp. Musa Bello', kobo: 500_000 }] });
    expect((await http.get('/me/station/payouts?from=2020-01-01&to=2020-01-31').set(as('head')).expect(200)).body.totals.paid).toBe(0);

    // Only the station head: not dispatchers, officers or the agency admin through this route.
    for (const who of ['dispatcher', 'officer', 'agencyAdmin']) {
      await http.get('/me/station/payouts').set(as(who)).expect(403);
      await http.get('/me/station/donations').set(as(who)).expect(403);
    }
  });
});
