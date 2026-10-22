// Staff two-step login: phone code, then an authenticator-app code (set up once), or a recovery code.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, matchStep, stepNow, totpAt } from '../src/auth/totp';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { createApp } from '../src/main';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
const STAFF = '+2348030000004'; // CSP Ngozi Eze, station head (seeded)
const CITIZEN = '+2348030000001';

async function lastCode(p: string): Promise<string> {
  const out = (await http.get('/dev/sms')).body as Array<{ to: string; body: string }>;
  return /code is (\d{6})/.exec([...out].reverse().find((m) => m.to === p)?.body ?? '')![1]!;
}
async function phoneSignIn(p: string) {
  await db.query(`delete from otp_challenges where phone = $1`, [p]);
  await http.post('/auth/otp/start').send({ phone: p }).expect(200);
  return (await http.post('/auth/otp/verify').send({ phone: p, code: await lastCode(p), device: { label: 'Dashboard', platform: 'web' } }).expect(200)).body;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const codeNow = (key: string, offset = 0) => totpAt(base32Decode(key), stepNow() + offset);

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  await http.post('/dev/seed').expect(201);
});
afterAll(async () => {
  await app?.close();
});

describe('authenticator codes', () => {
  it('matches the RFC 6238 test vector and never accepts a code twice', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpAt(secret, 1)).toBe('287082'); // T = 59 s
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    const now = 1_000_000;
    expect(matchStep(secret, totpAt(secret, now), null, now)).toBe(now);
    expect(matchStep(secret, totpAt(secret, now - 1), null, now)).toBe(now - 1); // clock drift
    expect(matchStep(secret, totpAt(secret, now - 2), null, now)).toBeNull();
    expect(matchStep(secret, totpAt(secret, now), now, now)).toBeNull(); // already used
  });
});

describe('staff two-step login', () => {
  let key = '';
  let recovery: string[] = [];

  it('stops staff after the phone code until the app is set up; setting up returns recovery codes once', async () => {
    const s = await phoneSignIn(STAFF);
    expect(s.secondFactorRequired).toBe(true);
    // Nothing else works yet.
    expect((await http.get('/me').set(bearer(s.accessToken)).expect(403)).body.code).toBe('mfa_required');
    expect((await http.get('/auth/mfa').set(bearer(s.accessToken)).expect(200)).body).toMatchObject({ required: true, enrolled: false, passed: false });

    const setup = (await http.post('/auth/mfa/setup').set(bearer(s.accessToken)).expect(200)).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/ERP%20Nigeria%3ACSP%20Ngozi%20Eze\?secret=[A-Z2-7]+&issuer=ERP%20Nigeria/);
    key = setup.key.replace(/\s/g, '');
    const stored = (await db.query(`select secret_enc from staff_totp`)).rows[0].secret_enc;
    expect(stored).not.toContain(key); // kept encrypted

    expect((await http.post('/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: '000000' }).expect(400)).body.code).toBe('code_wrong');
    const done = (await http.post('/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: codeNow(key) }).expect(200)).body;
    recovery = done.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(recovery[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect((await http.get('/me').set(bearer(done.accessToken)).expect(200)).body.name).toBe('CSP Ngozi Eze');
    await http.post('/auth/mfa/setup').set(bearer(done.accessToken)).expect(409);
  });

  it('asks for the app code at each sign-in; a code works once; a recovery code works once', async () => {
    const s = await phoneSignIn(STAFF);
    expect(s.secondFactorRequired).toBe(true);
    expect((await http.get('/auth/mfa').set(bearer(s.accessToken)).expect(200)).body).toMatchObject({ enrolled: true, passed: false });
    // The code used to confirm set-up cannot be used again (same 30 seconds).
    await http.post('/auth/mfa/verify').set(bearer(s.accessToken)).send({ code: codeNow(key) }).expect(400);
    const viaRecovery = (await http.post('/auth/mfa/verify').set(bearer(s.accessToken)).send({ recoveryCode: recovery[0] }).expect(200)).body;
    expect(viaRecovery.recoveryCodesLeft).toBe(9);
    await http.get('/me').set(bearer(viaRecovery.accessToken)).expect(200);

    const s2 = await phoneSignIn(STAFF);
    await http.post('/auth/mfa/verify').set(bearer(s2.accessToken)).send({ recoveryCode: recovery[0] }).expect(400);
    await http.post('/auth/mfa/verify').set(bearer(s2.accessToken)).send({}).expect(400);
    // Refreshing keeps the session's second step.
    const ok = (await http.post('/auth/mfa/verify').set(bearer(s2.accessToken)).send({ recoveryCode: recovery[1] }).expect(200)).body;
    const refreshed = (await http.post('/auth/refresh').send({ refreshToken: s2.refreshToken }).expect(200)).body;
    await http.get('/me').set(bearer(refreshed.accessToken)).expect(200);
    await http.get('/me').set(bearer(ok.accessToken)).expect(200);
    const actions = (await db.query(`select action from audit_log where action like 'auth.mfa%' order by id`)).rows.map((r) => r.action);
    expect(actions).toEqual(['auth.mfa_enrolled', 'auth.mfa_passed', 'auth.mfa_passed']);
  });

  it('ends the session after five wrong codes', async () => {
    const s = await phoneSignIn(STAFF);
    for (let i = 0; i < 4; i++) await http.post('/auth/mfa/verify').set(bearer(s.accessToken)).send({ code: '111111' }).expect(400);
    expect((await http.post('/auth/mfa/verify').set(bearer(s.accessToken)).send({ code: '111111' }).expect(401)).body.code).toBe('mfa_locked');
    await http.get('/auth/mfa').set(bearer(s.accessToken)).expect(401);
    expect((await db.query(`select count(*)::int as n from audit_log where action = 'auth.mfa_locked'`)).rows[0].n).toBe(1);
  });

  it('limits wrong codes while setting up too', async () => {
    // Start again as someone who has not set up the app.
    await db.query(`delete from staff_totp`);
    const s = await phoneSignIn(STAFF);
    await http.post('/auth/mfa/setup').set(bearer(s.accessToken)).expect(200);
    for (let i = 0; i < 4; i++) await http.post('/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: '222222' }).expect(400);
    expect((await http.post('/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: '222222' }).expect(401)).body.code).toBe('mfa_locked');
  });

  it('does not ask citizens for a second step', async () => {
    const s = await phoneSignIn(CITIZEN);
    expect(s.secondFactorRequired).toBe(false);
    await http.get('/me').set(bearer(s.accessToken)).expect(200);
  });
});
