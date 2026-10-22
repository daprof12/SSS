// Web push: devices are saved per person; notifications written anywhere are pushed within seconds,
// offers as urgent; dropped devices are forgotten; old and muted notifications are not pushed.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPushAdapter, PUSH, pushFromEnv, WebPushAdapter } from '../src/adapters/push';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { PushService } from '../src/push/push.service';
import { createApp } from '../src/main';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
let push: PushService;
let outbox: MockPushAdapter;
let users: Record<string, string>;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const device = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }, label: 'Android phone' });

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  push = app.get(PushService);
  outbox = app.get(PUSH) as MockPushAdapter;
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [seed.stationId, u, lng, lat]);
  }
});
afterAll(async () => {
  await app?.close();
});

describe('push', () => {
  it('needs VAPID keys in production', () => {
    expect(() => pushFromEnv('production', {})).toThrow(/VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY/);
    expect(pushFromEnv('production', { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })).toBeInstanceOf(WebPushAdapter);
    expect(pushFromEnv('development', {}).publicKey).toBeNull();
  });

  it('saves a device per person, and only https push endpoints', async () => {
    expect((await http.get('/push/key').expect(200)).body).toEqual({ publicKey: 'BTestPublicKey', enabled: true });
    await http.post('/me/push').set(as('officer')).send({ ...device(1), endpoint: 'http://evil.example/x' }).expect(400);
    expect((await http.post('/me/push').set(as('officer')).send(device(1)).expect(200)).body).toMatchObject({ enabled: true, devices: 1 });
    await http.post('/me/push').set(as('officer')).send(device(2)).expect(200);
    // The same phone signed in as someone else now belongs to them.
    await http.post('/me/push').set(as('officer2')).send(device(2)).expect(200);
    expect((await http.get('/me/push').set(as('officer')).expect(200)).body.devices).toBe(1);
    expect((await http.get('/me/push').set(as('officer2')).expect(200)).body.devices).toBe(1);
  });

  it('pushes a new offer to the officer at once, as urgent, linking to the offer', async () => {
    await push.deliverPending(); // anything from the seed
    outbox.outbox.length = 0;
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: `push-${Date.now()}` }).expect(201)).body.id;
    for (let i = 0; i < 100 && !(await db.query(`select 1 from incident_units where incident_id = $1 and state = 'offered'`, [id])).rowCount; i++) await sleep(50);
    expect(await push.deliverPending()).toBeGreaterThan(0);
    const offer = outbox.outbox.find((m) => m.link === `/offers/${id}`);
    expect(offer).toMatchObject({ to: device(1).endpoint, title: 'New offer', urgent: true, tag: `new_offer:/offers/${id}` });
    // Each notification is pushed once.
    expect(await push.deliverPending()).toBe(0);
  });

  it('skips stale and muted notifications; dispatch cannot be muted', async () => {
    outbox.outbox.length = 0;
    const note = (grp: string, title: string, ago = '0 minutes') =>
      db.query(`insert into notifications (user_id, type, grp, channel, title, body, sent_at) values ($1, 'x', $2, 'in_app', $3, 'b', now() - $4::interval)`, [users.officer, grp, title, ago]);
    await note('dispatch', 'Old offer', '30 minutes');
    await note('learn', 'New article');
    await db.query(`insert into notification_prefs (user_id, grp, channel, enabled) values ($1, 'reports', 'push', false)`, [users.officer]);
    await note('reports', 'Muted report update');
    await note('team', 'Rating received');
    await push.deliverPending();
    expect(outbox.outbox.map((m) => m.title)).toEqual(['Rating received']);
  });

  it('forgets a device the browser dropped', async () => {
    outbox.gone.add(device(1).endpoint);
    await http.post('/me/push/test').set(as('officer')).expect(200);
    await push.deliverPending();
    expect((await http.get('/me/push').set(as('officer')).expect(200)).body.devices).toBe(0);
  });

  it('turns off for one device', async () => {
    await http.post('/me/push').set(as('officer')).send(device(3)).expect(200);
    expect((await http.delete('/me/push').set(as('officer')).send({ endpoint: device(3).endpoint }).expect(200)).body.devices).toBe(0);
  });
});
