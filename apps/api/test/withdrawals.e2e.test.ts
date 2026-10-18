// Withdrawals: bank account in the verified name, PIN, first one held, Paystack transfer, arrived or refunded.
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
const key = () => `wd-${Date.now()}-${++n}`;
const available = async (who: string) => (await http.get('/me/wallet').set(as(who))).body.availableKobo as number;
const withdraw = (who: string, amountKobo: number, pin: string, k = key()) => http.post('/me/withdrawals').set(as(who)).set('Idempotency-Key', k).send({ amountKobo, pin });

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  users = (await http.post('/dev/seed').expect(201)).body.users;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  // ₦50,000 in the citizen's wallet through the normal fund flow.
  const f = (await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', key()).send({ amountKobo: 5_000_000, method: 'card' }).expect(201)).body;
  await http.post(`/dev/paystack/complete/${f.reference}`).expect(201);
});
afterAll(async () => {
  await app?.close();
});

describe('PIN', () => {
  it('needs a strong 4-digit PIN, and the current one to change it', async () => {
    expect((await http.get('/me/pin').set(as('citizen')).expect(200)).body.set).toBe(false);
    expect((await http.put('/me/pin').set(as('citizen')).send({ pin: '1234' }).expect(422)).body.message).toBe('Avoid digits in a row, like 1234.');
    expect((await http.put('/me/pin').set(as('citizen')).send({ pin: '4821' }).expect(200)).body.message).toBe('PIN set. You will use it for every withdrawal.');
    expect((await http.put('/me/pin').set(as('citizen')).send({ pin: '5930' }).expect(422)).body.message).toBe('Enter your current PIN.');
    await http.put('/me/pin').set(as('citizen')).send({ pin: '5930', currentPin: '4821' }).expect(200);
  });
});

describe('bank account', () => {
  it('only accepts an account in the verified name', async () => {
    expect((await http.post('/me/withdrawals/quote').set(as('citizen')).send({ amountKobo: 2_000_000 }).expect(422)).body.message).toBe('Add a bank account in your name first.');
    expect((await http.post('/me/bank-account/resolve').set(as('citizen')).send({ bankCode: '058', accountNumber: '12345' }).expect(422)).body.message).toBe('Enter the 10-digit account number.');
    expect((await http.post('/me/bank-account/resolve').set(as('citizen')).send({ bankCode: '058', accountNumber: '0123459999' }).expect(422)).body.message).toBe('We could not find that account. Check the number and the bank.');
    expect((await http.post('/me/bank-account/resolve').set(as('citizen')).send({ bankCode: '058', accountNumber: '0123450000' }).expect(201)).body).toMatchObject({ matches: false, verifiedName: 'Ada Obi' });
    expect((await http.put('/me/bank-account').set(as('citizen')).send({ bankCode: '058', accountNumber: '0123450000', pin: '5930' }).expect(422)).body.message).toBe('This account name does not match your verified name.');
    await http.put('/me/bank-account').set(as('citizen')).send({ bankCode: '058', accountNumber: '0123456789' }).expect(422); // PIN needed once set
    const b = (await http.put('/me/bank-account').set(as('citizen')).send({ bankCode: '058', accountNumber: '0123456789', pin: '5930' }).expect(200)).body;
    expect(b).toMatchObject({ bankName: 'GTBank', lastFour: '6789', nameMatches: true, message: 'GTBank, ending 6789 saved.' });
    // An officer's rank is not part of their verified name.
    expect((await http.post('/me/bank-account/resolve').set(as('officer')).send({ bankCode: '011', accountNumber: '2023456789' }).expect(201)).body).toMatchObject({ matches: true, verifiedName: 'Musa Bello' });
    // Changing an account tells the owner at once.
    await http.put('/me/bank-account').set(as('officer')).send({ bankCode: '011', accountNumber: '2023456789' }).expect(200);
    await http.put('/me/bank-account').set(as('officer')).send({ bankCode: '057', accountNumber: '3023456789' }).expect(200);
    expect((await http.get('/me/notifications').set(as('officer'))).body.items.find((x: any) => x.type === 'bank_changed').body).toBe(
      'Withdrawals now go to Zenith Bank, ending 6789. If this was not you, contact support now.',
    );
  });
});

describe('withdrawing', () => {
  it('quotes, holds the first one, sends it, and it arrives', async () => {
    expect((await http.post('/me/withdrawals/quote').set(as('citizen')).send({ amountKobo: 50_000 }).expect(422)).body.message).toBe('Minimum withdrawal is ₦1,000.00.');
    expect((await http.post('/me/withdrawals/quote').set(as('citizen')).send({ amountKobo: 9_000_000 }).expect(422)).body.message).toBe('You do not have that much available.');
    const q = (await http.post('/me/withdrawals/quote').set(as('citizen')).send({ amountKobo: 2_000_000 }).expect(201)).body;
    expect(q).toMatchObject({ feeKobo: 2_500, netKobo: 1_997_500, heldFirst: true, bank: { name: 'GTBank', lastFour: '6789' } });
    expect(q.confirm).toBe('Withdraw ₦20,000.00 to GTBank, ending 6789? Your first withdrawal to this account is sent after 24 hours, then arrives within 24 hours.');

    expect((await withdraw('citizen', 2_000_000, '1111').expect(422)).body.message).toBe('Wrong PIN. 4 tries left.');
    const k = key();
    const w = (await withdraw('citizen', 2_000_000, '5930', k).expect(201)).body;
    expect(w.state).toBe('held_first');
    expect((await withdraw('citizen', 2_000_000, '5930', k).expect(201)).body).toMatchObject({ id: w.id, replayed: true });
    expect(await available('citizen')).toBe(3_000_000);
    expect((await http.get('/me/withdrawals').set(as('citizen'))).body[0]).toMatchObject({ state: 'held_first', line: expect.stringMatching(/^Sent on /), bank: 'GTBank, ending 6789' });
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'withdrawal_held').body).toMatch(/^₦20,000\.00 will be sent to GTBank on /);

    // The hold ends: the job sends it, Paystack confirms, and the bank account is now trusted.
    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.withdrawalsReleased).toBe(0);
    await db.query(`update withdrawals set release_at = now() - interval '1 minute' where id = $1`, [w.id]);
    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.withdrawalsReleased).toBe(1);
    await http.post(`/dev/paystack/withdrawal/${w.id}`).expect(201);
    expect((await http.get('/me/withdrawals').set(as('citizen'))).body[0]).toMatchObject({ state: 'arrived', line: 'Arrived', netKobo: 1_997_500 });
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'withdrawal_done').body).toBe('₦19,975.00 reached GTBank.');
  });

  it('sends later ones at once, and refunds a failed transfer', async () => {
    const before = await available('citizen');
    const w = (await withdraw('citizen', 1_000_000, '5930').expect(201)).body;
    expect(w.state).toBe('processing');
    await http.post(`/dev/paystack/withdrawal/${w.id}?outcome=failed`).expect(201);
    expect((await http.get('/me/withdrawals').set(as('citizen'))).body[0]).toMatchObject({ state: 'failed_refunded', line: 'Failed, money returned' });
    expect(await available('citizen')).toBe(before);
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'withdrawal_failed').body).toBe('Your withdrawal failed and the money is back in your wallet.');
    const ledger = await db.query(`select sum(amount_kobo)::bigint as s from wallet_ledger where reference = $1`, [`wd:${w.id}`]);
    expect(Number(ledger.rows[0].s)).toBe(0);
  });

  it('blocks a bank change while a withdrawal is in progress, and locks the PIN after 5 wrong tries', async () => {
    const w = (await withdraw('citizen', 1_000_000, '5930').expect(201)).body;
    expect((await http.put('/me/bank-account').set(as('citizen')).send({ bankCode: '057', accountNumber: '3123456789', pin: '5930' }).expect(409)).body.message).toBe(
      'Wait for your withdrawal to finish before changing your bank account.',
    );
    await http.post(`/dev/paystack/withdrawal/${w.id}`).expect(201);

    for (let i = 0; i < 4; i++) await withdraw('citizen', 100_000, '0000').expect(422);
    expect((await withdraw('citizen', 100_000, '0000').expect(423)).body.message).toBe('Too many wrong tries. Your PIN is locked for 30 minutes.');
    expect((await withdraw('citizen', 100_000, '5930').expect(423)).body.message).toMatch(/^Too many wrong tries\. Try again at \d\d:\d\d\.$/);
  });

  it('resets a forgotten PIN with an SMS code, even while locked, and then holds withdrawals for 24 hours', async () => {
    const start = (await http.post('/me/pin/reset/start').set(as('citizen')).expect(201)).body;
    expect(start).toMatchObject({ sent: true, expiresInSeconds: 300 });
    expect((await http.post('/me/pin/reset/start').set(as('citizen')).expect(429)).body.message).toMatch(/^Wait \d+ seconds before asking for a new code\.$/);
    const sms = (await http.get('/dev/sms')).body.filter((m: any) => m.to === '+2348030000001').pop();
    expect(sms.body).toMatch(/^Your ERP code to reset your withdrawal PIN is \d{6}\./);
    const code = /(\d{6})/.exec(sms.body)![1]!;

    // A reset code is never a sign-in code.
    await http.post('/auth/otp/verify').send({ phone: '+2348030000001', code }).expect(400);

    expect((await http.post('/me/pin/reset').set(as('citizen')).send({ code, pin: '0000' }).expect(422)).body.message).toBe('Avoid the same digit four times.');
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await http.post('/me/pin/reset').set(as('citizen')).send({ code: wrong, pin: '7302' }).expect(400)).body.message).toBe('That code is not right. 4 tries left.');
    expect((await http.post('/me/pin/reset').set(as('citizen')).send({ code, pin: '7302' }).expect(201)).body.message).toBe(
      'PIN reset. Withdrawals in the next 24 hours wait before they are sent, to keep your money safe.',
    );
    await http.post('/me/pin/reset').set(as('citizen')).send({ code, pin: '7302' }).expect(400); // one use only
    expect((await http.get('/me/pin').set(as('citizen'))).body).toMatchObject({ set: true, lockedUntil: null, resetHoldUntil: expect.any(String) });

    // The account has been paid before, but a fresh reset still holds money for a day.
    const q = (await http.post('/me/withdrawals/quote').set(as('citizen')).send({ amountKobo: 200_000 }).expect(201)).body;
    expect(q).toMatchObject({ heldFirst: true, holdReason: 'pin_reset' });
    expect(q.confirm).toMatch(/Your PIN was reset recently, so it is sent on /);
    const w = (await withdraw('citizen', 200_000, '7302').expect(201)).body;
    expect(w.state).toBe('held_first');
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'pin_reset').title).toBe('Withdrawal PIN reset');
  });
});
