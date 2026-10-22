// Photos and videos, the scheduled rules, and the issue brief with its share link.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { createApp } from '../src/main';
import { sniff, stripJpegMetadata } from '../src/media/media.service';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
let seed: { users: Record<string, string>; naptipId: string; fermaId: string };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let n = 0;
const ref = () => `media-${Date.now()}-${++n}`;

// A tiny JPEG with an APP1 "Exif" segment carrying a fake GPS marker.
const EXIF = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPS-6.45\0')]);
const JFIF = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), EXIF, JFIF, SCAN]);
// WebM (EBML header), as Chrome and Android record voice notes.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 2)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

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

/** Rewrites an append-only row's time, for tests only. */
async function backdate(table: 'issue_events' | 'wallet_ledger', set: string, where: string, params: unknown[]) {
  await db.tx(async (c) => {
    await c.query(`alter table ${table} disable trigger ${table}_immutable`);
    await c.query(`update ${table} set ${set} where ${where}`, params);
    await c.query(`alter table ${table} enable trigger ${table}_immutable`);
  });
}

const issue = (who: string) =>
  http.post('/issues').set(as(who)).send({ category: 'road', subtype: 'Pothole', severity: 'dangerous', description: 'Deep pothole by the bus stop', clientRef: ref(), postcode: 'GH78J' }).expect(201).then((r) => r.body.id as string);
const attach = async (who: string, ownerType: string, ownerId: string, bytes: Buffer, contentType: string, status = 200, extra: Record<string, unknown> = {}) => {
  const reg = (await http.post('/media').set(as(who)).send({ ownerType, ownerId, contentType, sizeBytes: bytes.length, ...extra }).expect(201)).body;
  return http.put(reg.uploadUrl).set(as(who)).set('Content-Type', contentType.split(';')[0]!).send(bytes).expect(status);
};

describe('file checks', () => {
  it('recognises files by their bytes, not their names', () => {
    expect(sniff(JPEG)).toBe('jpeg');
    expect(sniff(PNG)).toBe('png');
    expect(sniff(WEBM)).toBe('webm');
    expect(sniff(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('removes location data from photos', () => {
    const clean = stripJpegMetadata(JPEG);
    expect(clean.includes(Buffer.from('GPS'))).toBe(false);
    expect(clean.includes(JFIF)).toBe(true);
    expect(clean.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });
});

describe('attachments', () => {
  it('lets a reporter add photos to an issue and the agency see them, with each look logged', async () => {
    const caseId = await issue('citizen');
    const up = (await attach('citizen', 'issue_case', caseId, JPEG, 'image/jpeg')).body;
    expect(up).toMatchObject({ state: 'ready', kind: 'photo' });

    const list = (await http.get('/attachments').query({ ownerType: 'issue_case', ownerId: caseId }).set(as('citizen')).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'photo', mine: true });

    const own = await http.get(`/media/${up.id}/content`).set(as('citizen')).buffer(true).expect(200);
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(own.body).includes(Buffer.from('GPS'))).toBe(false);

    await http.get(`/media/${up.id}/content`).set(as('fermaAdmin')).expect(200);
    const logged = await db.query(`select actor_id from audit_log where action = 'media.view' and entity_id = $1`, [up.id]);
    expect(logged.rows.map((r) => r.actor_id)).toEqual([seed.users.fermaAdmin]);

    // Someone who did not report it sees nothing.
    await http.get(`/media/${up.id}/content`).set(as('officer')).expect(404);
    await http.get('/attachments').query({ ownerType: 'issue_case', ownerId: caseId }).set(as('officer')).expect(404);
  });

  it('rejects a file whose bytes do not match its type, and oversize or unknown types', async () => {
    const caseId = await issue('citizen');
    const bad = await attach('citizen', 'issue_case', caseId, Buffer.from('<html><script>x</script></html>'), 'image/png', 422);
    expect(bad.body.message).toBe('This file is too large or not supported.');
    await http.post('/media').set(as('citizen')).send({ ownerType: 'issue_case', ownerId: caseId, contentType: 'image/svg+xml', sizeBytes: 10 }).expect(422);
    await http.post('/media').set(as('citizen')).send({ ownerType: 'issue_case', ownerId: caseId, contentType: 'video/mp4', sizeBytes: 11 * 1024 * 1024 }).expect(422);
  });

  it('only the tipper adds to a tip, and only while it is open', async () => {
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'Girls are kept in a house on Allen and moved at night by a white bus.', clientRef: ref(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    await attach('citizen', 'tip', tip.id, PNG, 'image/png');
    await http.post('/media').set(as('neighbour')).send({ ownerType: 'tip', ownerId: tip.id, contentType: 'image/png', sizeBytes: 10 }).expect(404);
    expect((await http.get('/attachments').query({ ownerType: 'tip', ownerId: tip.id }).set(as('naptipAdmin')).expect(200)).body).toHaveLength(1);
  });

  it('adds a photo to a live report and tells responders', async () => {
    const inc = (await http.post('/incidents').set(as('citizen')).send({ type: 'fire', postcode: 'GH78J', clientRef: ref() }).expect(201)).body;
    await attach('citizen', 'incident', inc.id, JPEG, 'image/jpeg');
    const ev = await db.query(`select payload from incident_events where incident_id = $1 and kind = 'add_info'`, [inc.id]);
    expect(ev.rows[0].payload.label).toBe('Photo added');
    await http.post('/media').set(as('neighbour')).send({ ownerType: 'incident', ownerId: inc.id, contentType: 'image/png', sizeBytes: 10 }).expect(404);
  });
});

describe('voice notes', () => {
  it('takes a voice note on a tip and tells responders on a live report', async () => {
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'Girls are kept in a house on Allen and moved at night by a white bus.', clientRef: ref(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    const up = (await attach('citizen', 'tip', tip.id, WEBM, 'audio/webm;codecs=opus', 200, { durationS: 14 })).body;
    expect(up).toMatchObject({ kind: 'voice' });
    expect((await http.get('/attachments').query({ ownerType: 'tip', ownerId: tip.id }).set(as('naptipAdmin'))).body[0]).toMatchObject({ kind: 'voice', contentType: 'audio/webm', durationS: 14 });

    // Over two minutes, or bytes that are not audio, are refused.
    expect((await http.post('/media').set(as('citizen')).send({ ownerType: 'tip', ownerId: tip.id, contentType: 'audio/webm', sizeBytes: 100, durationS: 200 }).expect(422)).body.message).toBe('Voice notes can be up to 2 minutes.');
    await attach('citizen', 'tip', tip.id, JPEG, 'audio/webm', 422);

    const inc = (await http.post('/incidents').set(as('citizen')).send({ type: 'fire', postcode: 'GH78J', clientRef: ref() }).expect(201)).body;
    await attach('citizen', 'incident', inc.id, WEBM, 'audio/webm', 200, { durationS: 5 });
    const ev = await db.query(`select payload from incident_events where incident_id = $1 and kind = 'add_info'`, [inc.id]);
    expect(ev.rows[0].payload.label).toBe('Voice note added');
  });
});

describe('picking a building', () => {
  it('lists buildings with postcodes around a point, and they resolve when a report uses them', async () => {
    const r = (await http.get('/places/within?lat=6.60165&lng=3.35185&radius=60').set(as('citizen')).expect(200)).body;
    expect(r.radiusM).toBe(60);
    expect(r.buildings.length).toBeGreaterThan(3);
    expect(r.buildings.every((b: any) => b.distanceM <= 60)).toBe(true);
    expect(r.buildings.map((b: any) => b.distanceM)).toEqual([...r.buildings.map((b: any) => b.distanceM)].sort((a: number, b: number) => a - b));
    const wide = (await http.get('/places/within?lat=6.60165&lng=3.35185&radius=250').set(as('citizen')).expect(200)).body;
    expect(wide.buildings.length).toBeGreaterThan(r.buildings.length);
    await http.get('/places/within?lat=6.6&lng=3.35&radius=900').set(as('citizen')).expect(400);

    const pick = r.buildings[0];
    expect((await http.get(`/places/lookup?postcode=${pick.postcode}`).set(as('citizen')).expect(200)).body).toMatchObject({ postcode: pick.postcode, lat: pick.lat });
    const created = (
      await http.post('/issues').set(as('citizen')).send({ category: 'road', subtype: 'Pothole', severity: 'small', description: 'Pothole outside the gate', clientRef: ref(), postcode: pick.postcode }).expect(201)
    ).body;
    expect((await http.get(`/issues/${created.id}`).set(as('citizen'))).body.place).toContain(pick.postcode);
  });
});

describe('scheduled rules', () => {
  it('closes a fix as confirmed after 7 days of silence', async () => {
    const caseId = await issue('citizen');
    const act = (body: Record<string, unknown>) => http.post(`/agencies/${seed.fermaId}/issues/${caseId}/actions`).set(as('fermaAdmin')).send(body).expect(201);
    await act({ event: 'assign' });
    await act({ event: 'mark_fixed', note: 'Patched' });

    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.fixSilence).toBe(0);
    await backdate('issue_events', `at = now() - interval '8 days'`, `case_id = $1 and kind = 'mark_fixed'`, [caseId]);
    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.fixSilence).toBe(1);

    const d = (await http.get(`/issues/${caseId}`).set(as('citizen')).expect(200)).body;
    expect(d.state).toBe('fixed');
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'issue_fixed');
    expect(note.body).toMatch(/after 7 days/);
  });

  it('releases a held bounty when the hold ends', async () => {
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'Girls are kept in a house on Allen and moved at night by a white bus.', clientRef: ref(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    const act = (body: Record<string, unknown>) => http.post(`/agencies/${seed.naptipId}/tips/${tip.id}/actions`).set(as('naptipAdmin')).send(body).expect(201);
    await act({ event: 'outcome_recorded', outcome: 'arrest' });
    await act({ event: 'approve' });
    expect((await http.get(`/tips/${tip.id}`).set(as('citizen'))).body.state).toBe('approved_held');

    await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201);
    expect((await http.get(`/tips/${tip.id}`).set(as('citizen'))).body.state).toBe('approved_held');

    await backdate('wallet_ledger', `available_at = now() - interval '1 minute'`, `reference = $1`, [`tip:${tip.id}`]);
    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.bountyRelease).toBe(1);
    expect((await http.get(`/tips/${tip.id}`).set(as('citizen'))).body.state).toBe('available');
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'bounty_available');
    expect(note.title).toBe('Bounty ready');
  });
});

describe('issue brief and share link', () => {
  it('downloads a PDF brief, logged', async () => {
    const caseId = await issue('citizen');
    await issue('neighbour');
    const r = await http.get(`/agencies/${seed.fermaId}/issues/${caseId}/brief.pdf`).set(as('fermaAdmin')).buffer(true).expect(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(r.body).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await db.query(`select 1 from audit_log where action = 'issue.brief_download' and entity_id = $1`, [caseId])).rowCount).toBe(1);
    await http.get(`/agencies/${seed.fermaId}/issues/${caseId}/brief.pdf`).set(as('citizen')).expect(404);
  });

  it('shares a view-only link that never names reporters, counts views, and can be turned off', async () => {
    const caseId = await issue('citizen');
    const base = `/agencies/${seed.fermaId}/issues/${caseId}/shares`;
    expect((await http.post(base).set(as('fermaAdmin')).send({ note: 'x', days: 3 }).expect(400)).body.fields[0].message).toBe('Say why you are sharing this.');
    await http.post(base).set(as('fermaAdmin')).send({ note: 'For the commissioner', days: 30 }).expect(400);
    const s = (await http.post(base).set(as('fermaAdmin')).send({ note: 'For the commissioner', days: 3 }).expect(201)).body;
    expect(s.path).toBe(`/shared/${s.token}`);

    const v = (await http.get(`/shared/issues/${s.token}`).expect(200)).body;
    expect(v.share.note).toBe('For the commissioner');
    expect(v.brief).toMatchObject({ agency: 'FERMA (demo)', reports: expect.any(Number) });
    const text = JSON.stringify(v);
    expect(text).not.toContain(seed.users.citizen);
    expect(text).not.toContain('agencyId');
    await http.get(`/shared/issues/${s.token}/brief.pdf`).expect(200);

    const list = (await http.get(base).set(as('fermaAdmin')).expect(200)).body;
    expect(list[0]).toMatchObject({ status: 'active', views: 2 });
    expect(JSON.stringify(list)).not.toContain(s.token);

    await http.delete(`${base}/${s.id}`).set(as('fermaAdmin')).expect(200);
    expect((await http.get(`/shared/issues/${s.token}`).expect(410)).body.message).toBe('This link has expired.');
    await http.get('/shared/issues/not-a-real-token-at-all-xx').expect(404);
  });
});
