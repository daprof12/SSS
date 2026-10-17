// Phone OTP sign-in, sessions and onboarding (C3, C6; Security doc).
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
let seq = 100;
const phone = () => `+23481${String(Date.now()).slice(-6)}${String(++seq).slice(-2)}`;

async function lastCode(p: string): Promise<string> {
  const out = (await http.get('/dev/sms')).body as Array<{ to: string; body: string }>;
  const msg = [...out].reverse().find((m) => m.to === p);
  return /code is (\d{6})/.exec(msg?.body ?? '')![1]!;
}
async function signIn(p: string) {
  await http.post('/auth/otp/start').send({ phone: p }).expect(200);
  const code = await lastCode(p);
  return (await http.post('/auth/otp/verify').send({ phone: p, code, device: { label: 'Test phone', platform: 'web' } }).expect(200)).body;
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
});
afterAll(async () => {
  await app?.close();
});

describe('sending a code', () => {
  it('accepts Nigerian numbers in any common form and masks them back', async () => {
    const r = await http.post('/auth/otp/start').send({ phone: '0803 123 4567' }).expect(200);
    expect(r.body).toEqual({ sent: true, phone: '+234803•••67', expiresInSeconds: 300, resendInSeconds: 60 });
    const bad = await http.post('/auth/otp/start').send({ phone: '+44 7700 900123' }).expect(422);
    expect(bad.body.message).toBe('Enter a Nigerian phone number.');
  });

  it('never stores the code, only a hash', async () => {
    const p = phone();
    await http.post('/auth/otp/start').send({ phone: p }).expect(200);
    const code = await lastCode(p);
    const row = (await db.query(`select code_hash from otp_challenges where phone = $1`, [p])).rows[0];
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(code);
  });

  it('makes people wait 60 seconds before another code', async () => {
    const p = phone();
    await http.post('/auth/otp/start').send({ phone: p }).expect(200);
    const r = await http.post('/auth/otp/start').send({ phone: p }).expect(429);
    expect(r.body.message).toMatch(/^Wait \d+ seconds before asking for a new code\.$/);
    expect(r.body.retryInSeconds).toBeGreaterThan(50);
  });

  it('caps codes per phone per hour', async () => {
    const p = phone();
    for (let i = 0; i < 5; i++) await db.query(`insert into otp_challenges (phone, code_hash, expires_at, created_at) values ($1, 'x', now(), now() - interval '5 minutes')`, [p]);
    const r = await http.post('/auth/otp/start').send({ phone: p }).expect(429);
    expect(r.body.code).toBe('too_many_codes');
  });

  it('answers the same for a new number and a registered one', async () => {
    const known = phone();
    await signIn(known);
    await db.query(`update otp_challenges set created_at = now() - interval '2 minutes' where phone = $1`, [known]);
    const a = (await http.post('/auth/otp/start').send({ phone: known }).expect(200)).body;
    const b = (await http.post('/auth/otp/start').send({ phone: phone() }).expect(200)).body;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

describe('checking the code', () => {
  it('counts wrong tries, then locks even the right code', async () => {
    const p = phone();
    await http.post('/auth/otp/start').send({ phone: p }).expect(200);
    const right = await lastCode(p);
    const wrong = right === '000000' ? '111111' : '000000';
    const first = await http.post('/auth/otp/verify').send({ phone: p, code: wrong }).expect(400);
    expect(first.body.message).toBe('That code is not right. 4 tries left.');
    for (let i = 0; i < 3; i++) await http.post('/auth/otp/verify').send({ phone: p, code: wrong }).expect(400);
    const last = await http.post('/auth/otp/verify').send({ phone: p, code: wrong }).expect(400);
    expect(last.body.message).toBe('Too many tries. Send a new code.');
    const locked = await http.post('/auth/otp/verify').send({ phone: p, code: right }).expect(429);
    expect(locked.body.message).toBe('Too many tries. Send a new code.');
  });

  it('expires after 5 minutes and works only once', async () => {
    const p = phone();
    await http.post('/auth/otp/start').send({ phone: p }).expect(200);
    const code = await lastCode(p);
    await db.query(`update otp_challenges set expires_at = now() - interval '1 second' where phone = $1`, [p]);
    expect((await http.post('/auth/otp/verify').send({ phone: p, code }).expect(400)).body.message).toBe('Code expired. Send a new one.');

    const q = phone();
    await http.post('/auth/otp/start').send({ phone: q }).expect(200);
    const c2 = await lastCode(q);
    await http.post('/auth/otp/verify').send({ phone: q, code: c2 }).expect(200);
    expect((await http.post('/auth/otp/verify').send({ phone: q, code: c2 }).expect(400)).body.message).toBe('Code expired. Send a new one.');
  });

  it('creates a citizen on first sign-in and asks for a name', async () => {
    const p = phone();
    const s = await signIn(p);
    expect(s).toMatchObject({ isNew: true, needsName: true, surface: 'citizen', secondFactorRequired: false, expiresInSeconds: 900 });
    const me = (await http.get('/me').set('Authorization', `Bearer ${s.accessToken}`).expect(200)).body;
    expect(me.roles).toEqual([{ role: 'citizen', scopeType: 'self', scopeId: null }]);
    expect(me.onboarding).toMatchObject({ done: false, needsName: true });
    await db.query(`update otp_challenges set created_at = now() - interval '2 minutes' where phone = $1`, [p]);
    expect((await signIn(p)).isNew).toBe(false);
  });
});

describe('sessions', () => {
  it('rotates the refresh token so an old one never works twice', async () => {
    const s = await signIn(phone());
    const r1 = (await http.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200)).body;
    expect(r1.refreshToken).not.toBe(s.refreshToken);
    await http.get('/me').set('Authorization', `Bearer ${r1.accessToken}`).expect(200);
    const again = await http.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    expect(again.body.message).toBe('Your session has ended. Sign in again.');
  });

  it('ends the session at once on sign-out, before the token expires', async () => {
    const s = await signIn(phone());
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    await http.post('/auth/sign-out').set(auth).expect(204);
    await http.get('/me').set(auth).expect(401);
    await http.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });

  it('lists devices and revokes another one, but not the current', async () => {
    const p = phone();
    const a = await signIn(p);
    await db.query(`update otp_challenges set created_at = now() - interval '2 minutes' where phone = $1`, [p]);
    const b = await signIn(p);
    const list = (await http.get('/auth/sessions').set('Authorization', `Bearer ${a.accessToken}`).expect(200)).body;
    expect(list).toHaveLength(2);
    const current = list.find((x: any) => x.current);
    const other = list.find((x: any) => !x.current);
    await http.delete(`/auth/sessions/${current.id}`).set('Authorization', `Bearer ${a.accessToken}`).expect(409);
    await http.delete(`/auth/sessions/${other.id}`).set('Authorization', `Bearer ${a.accessToken}`).expect(204);
    await http.get('/me').set('Authorization', `Bearer ${b.accessToken}`).expect(401);
  });

  it('holds staff until their second factor', async () => {
    const seed = (await http.post('/dev/seed').expect(201)).body;
    const officerPhone = (await db.query(`select phone from users where id = $1`, [seed.users.officer])).rows[0].phone;
    const s = await signIn(officerPhone);
    expect(s).toMatchObject({ surface: 'officer', secondFactorRequired: true });
    const r = await http.get('/me').set('Authorization', `Bearer ${s.accessToken}`).expect(403);
    expect(r.body.code).toBe('mfa_required');
  });
});

describe('onboarding', () => {
  it('saves the name until KYC, then locks it', async () => {
    const s = await signIn(phone());
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    await http.patch('/me/profile').set(auth).send({ name: 'A' }).expect(400);
    await http.patch('/me/profile').set(auth).send({ name: 'Ngozi Okafor' }).expect(200);
    await http.patch('/me/onboarding').set(auth).send({ step: 'tour' }).expect(200);
    await http
      .post('/me/kyc')
      .set(auth)
      .send({ idType: 'nin', idNumber: '12345678901', firstName: 'Ngozi', lastName: 'Okafor', dateOfBirth: '1992-02-02', liveness: true })
      .expect(201);
    const locked = await http.patch('/me/profile').set(auth).send({ name: 'Someone Else' }).expect(409);
    expect(locked.body.message).toBe('Your name comes from your verified ID. Contact support to change it.');
    await http.patch('/me/onboarding').set(auth).send({ step: 'done' }).expect(200);
    const me = (await http.get('/me').set(auth)).body;
    expect(me).toMatchObject({ name: 'Ngozi Okafor', kyc: { status: 'verified' }, onboarding: { done: true, needsName: false } });
    expect(Object.keys(me.onboarding.steps)).toEqual(expect.arrayContaining(['tour', 'done']));
  });
});
