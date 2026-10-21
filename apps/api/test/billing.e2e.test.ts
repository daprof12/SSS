// Home plans: subscribe → install → active; monthly dunning stages; paying restores; live view and its log.
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
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let n = 0;
const key = () => `bk-${Date.now()}-${++n}`;

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  users = (await http.post('/dev/seed').expect(201)).body.users;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  await http.put('/me/pin').set(as('neighbour')).send({ pin: '7302' }).expect(200);
});
afterAll(async () => {
  await app?.close();
});

describe('protect your home', () => {
  let subId = '';
  it('lists plans with the install fee and first month', async () => {
    const p = (await http.get('/me/plans').set(as('neighbour')).expect(200)).body;
    expect(p.map((x: any) => x.code)).toEqual(['household', 'household_plus', 'community']);
    expect(p[0]).toMatchObject({ name: 'Household', priceKobo: 1500000, installFeeKobo: 7500000, line: '1 camera, 1 street light, incident briefs' });
  });

  it('pays install fee and first month by Paystack; an install job is created; billing has not started', async () => {
    const r = (await http.post('/me/subscriptions').set(as('neighbour')).set('Idempotency-Key', key()).send({ planCode: 'household', method: 'card' }).expect(201)).body;
    subId = r.subscriptionId;
    const pay = (await db.query(`select amount_kobo, purpose from payments where provider_ref = $1`, [r.reference])).rows[0];
    expect(pay).toMatchObject({ amount_kobo: 9000000, purpose: 'install' });
    await http.post(`/dev/paystack/complete/${r.reference}`).expect(201);
    const b = (await http.get('/me/home/billing').set(as('neighbour')).expect(200)).body;
    expect(b).toMatchObject({ state: 'install_pending', plan: { name: 'Household' }, problem: null });
    expect(b.install.number).toMatch(/^IN-\d{6}$/);
    // The owner of an existing plan cannot buy another for the same home.
    await http.post('/me/subscriptions').set(as('citizen')).set('Idempotency-Key', key()).send({ planCode: 'household', method: 'card' }).expect(409);
  });

  it('the installation team books the visit, then marks it installed: devices appear and the first month starts', async () => {
    await http.get('/admin/installs').set(as('neighbour')).expect(403);
    const jobs = (await http.get('/admin/installs').set(as('platformAdmin')).expect(200)).body;
    const j = jobs.find((x: any) => x.owner === 'Chidi Neighbour');
    expect(j).toMatchObject({ state: 'unassigned', plan: 'Household' });
    await http.post(`/admin/installs/${j.id}`).set(as('platformAdmin')).send({ action: 'installed' }).expect(409);
    await http.post(`/admin/installs/${j.id}`).set(as('platformAdmin')).send({ action: 'book', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), window: '9am to 12pm' }).expect(200);
    expect((await http.get('/me/home/billing').set(as('neighbour'))).body.state).toBe('install_booked');
    await http.post(`/admin/installs/${j.id}`).set(as('platformAdmin')).send({ action: 'installed' }).expect(200);
    const h = (await http.get('/me/home').set(as('neighbour'))).body;
    expect(h.home.plan).toMatchObject({ state: 'active', label: 'Active' });
    expect(h.devices.map((d: any) => d.name)).toEqual(['Front gate camera', 'Street light, outside']);
    const b = (await http.get('/me/home/billing').set(as('neighbour'))).body;
    expect(new Date(b.paidUntil).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  it('live view logs who looked; development gives a test feed', async () => {
    const cam = (await http.get('/me/home').set(as('neighbour'))).body.devices[0];
    const l = (await http.get(`/me/devices/${cam.id}/live`).set(as('neighbour')).expect(200)).body;
    expect(l).toMatchObject({ mode: 'test' });
    const v = (await http.get(`/me/devices/${cam.id}`).set(as('neighbour'))).body;
    expect(v.whoViewed[0]).toMatchObject({ name: 'Chidi Neighbour', role: 'owner', reason: 'Live view', via: 'app' });
  });

  it('a failed monthly charge pauses extras by day 8; paying from the wallet restores everything', async () => {
    await http.post('/dev/subscriptions/fail').send({ userId: users.neighbour, days: 9 }).expect(201);
    const b = (await http.get('/me/home/billing').set(as('neighbour'))).body;
    expect(b).toMatchObject({ state: 'extras_paused', problem: { amountKobo: 1500000, day: 9 } });
    expect(b.problem.stages.find((s: any) => s.current).title).toBe('extras pause');
    const cam = (await http.get('/me/home').set(as('neighbour'))).body.devices[0];
    expect((await http.get(`/me/devices/${cam.id}/live`).set(as('neighbour')).expect(402)).body.message).toMatch(/^Live view is paused until the monthly payment is made\./);
    expect((await http.get(`/me/devices/${cam.id}`).set(as('neighbour'))).body).toMatchObject({ canViewLive: false });
    // Report a problem always works.
    await http.post('/me/repairs').set(as('neighbour')).send({ deviceId: cam.id, problem: 'blurry', description: 'Picture is very dark at night.' }).expect(201);
    const note = (await http.get('/me/notifications').set(as('neighbour'))).body.items.find((x: any) => x.type === 'payment_failed');
    expect(note.body).toBe('We could not take ₦15,000.00 for your home plan. Everything keeps working for 7 days. Pay now to avoid any pause.');

    expect((await http.post('/me/home/billing/pay').set(as('neighbour')).set('Idempotency-Key', key()).send({ method: 'wallet', pin: '7302' }).expect(422)).body.code).toBe('insufficient_funds');
    const f = (await http.post('/me/wallet/fund').set(as('neighbour')).set('Idempotency-Key', key()).send({ amountKobo: 2000000, method: 'card' }).expect(201)).body;
    await http.post(`/dev/paystack/complete/${f.reference}`).expect(201);
    const paid = (await http.post('/me/home/billing/pay').set(as('neighbour')).set('Idempotency-Key', key()).send({ method: 'wallet', pin: '7302' }).expect(201)).body;
    expect(paid.message).toBe('Paid ₦15,000.00. Everything is back on.');
    expect((await http.get('/me/home/billing').set(as('neighbour'))).body).toMatchObject({ state: 'active', problem: null });
    expect((await http.get(`/me/devices/${cam.id}`).set(as('neighbour'))).body.canViewLive).toBe(true);
  });

  it('the dunning job moves a late plan through the stages by day', async () => {
    await http.post('/dev/subscriptions/fail').send({ userId: users.neighbour, days: 2 }).expect(201);
    expect((await http.get('/me/home/billing').set(as('neighbour'))).body.state).toBe('grace');
    await db.query(`update dunning_state set due_since = current_date - 16 where subscription_id = $1`, [subId]);
    await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201);
    expect((await http.get('/me/home/billing').set(as('neighbour'))).body.state).toBe('sharing_paused');
    const r = (await http.post('/me/home/billing/payment-plan').set(as('neighbour')).send({ note: 'Paid on the 28th' }).expect(200)).body;
    expect(r.message).toMatch(/^Asked\. We will call you within a working day\. Reference S-\d{6}\.$/);
    expect((await http.get('/me/home/billing').set(as('neighbour'))).body.problem.arrangement).toBe('payment_plan');
  });
});
