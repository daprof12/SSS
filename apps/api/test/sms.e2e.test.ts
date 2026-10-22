// Text messages: the Termii adapter, the log (codes blanked), and what happens when sending fails.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoggedSmsAdapter, MockSmsAdapter, redactCodes, SMS, smsFromEnv, TermiiSmsAdapter } from '../src/adapters/sms';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { createApp } from '../src/main';

type Call = { url: string; body: Record<string, unknown> };
/** A stand-in for Termii's API: answers in turn from `replies`. */
function fakeTermii(replies: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? { status: 200, body: { message_id: 'x' } };
    if (r === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const cfg = { apiKey: 'TLtestkey', senderId: 'ERP', baseUrl: 'https://v3.api.termii.com/' };

describe('Termii adapter', () => {
  it('sends codes on the DND route and other messages on the generic route, without the plus', async () => {
    const t = fakeTermii([{ status: 200, body: { message_id: '9122821270554876574', message: 'Successfully Sent', balance: 9, user: 'ERP' } }, { status: 200, body: { message_id: '2' } }]);
    const a = new TermiiSmsAdapter(cfg, t.impl);
    expect(await a.send({ to: '+2348031234567', body: 'Your ERP code is 123456.', urgent: true })).toEqual({ id: '9122821270554876574' });
    await a.send({ to: '+2348031234567', body: 'Station message', urgent: false });
    expect(t.calls[0]).toEqual({
      url: 'https://v3.api.termii.com/api/sms/send',
      body: { api_key: 'TLtestkey', to: '2348031234567', from: 'ERP', sms: 'Your ERP code is 123456.', type: 'plain', channel: 'dnd' },
    });
    expect(t.calls[1]!.body.channel).toBe('generic');
  });

  it('retries once on a network error or a 5xx, never on a refusal', async () => {
    const flaky = fakeTermii(['network', { status: 200, body: { message_id: 'ok' } }]);
    expect(await new TermiiSmsAdapter(cfg, flaky.impl).send({ to: '+2348031234567', body: 'x', urgent: true })).toEqual({ id: 'ok' });
    expect(flaky.calls).toHaveLength(2);

    const down = fakeTermii([{ status: 503, body: {} }, { status: 502, body: {} }]);
    await expect(new TermiiSmsAdapter(cfg, down.impl).send({ to: '+2348031234567', body: 'x', urgent: true })).rejects.toThrow(/Termii 502/);
    expect(down.calls).toHaveLength(2);

    const refused = fakeTermii([{ status: 400, body: { message: 'Insufficient balance' } }]);
    await expect(new TermiiSmsAdapter(cfg, refused.impl).send({ to: '+2348031234567', body: 'x', urgent: true })).rejects.toThrow('Termii 400: Insufficient balance');
    expect(refused.calls).toHaveLength(1);

    const local = fakeTermii([]);
    await expect(new TermiiSmsAdapter(cfg, local.impl).send({ to: '+447700900123', body: 'x', urgent: true })).rejects.toThrow('Enter a Nigerian phone number.');
    expect(local.calls).toHaveLength(0);
  });

  it('is chosen from the environment, and production will not start without a real provider', () => {
    expect(smsFromEnv('development', {})).toBeInstanceOf(MockSmsAdapter);
    expect(smsFromEnv('production', { SMS_PROVIDER: 'termii', TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'ERP' })).toBeInstanceOf(TermiiSmsAdapter);
    expect(() => smsFromEnv('production', {})).toThrow(/real SMS provider/);
    expect(() => smsFromEnv('production', { SMS_PROVIDER: 'mock' })).toThrow(/real SMS provider/);
    expect(() => smsFromEnv('production', { SMS_PROVIDER: 'termii' })).toThrow(/TERMII_API_KEY and TERMII_SENDER_ID/);
  });

  it('blanks codes out of the log', () => {
    expect(redactCodes('Your ERP code is 123456. It expires in 5 minutes.')).toBe('Your ERP code is ••••••. It expires in 5 minutes.');
    expect(redactCodes('Statement ST-2026-0042 code 4821')).toBe('Statement ST-••••-•••• code ••••');
  });
});

describe('sending codes for real', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: Db;
  let mock: MockSmsAdapter;

  beforeAll(async () => {
    execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
    app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
    await app.listen(0);
    http = request(app.getHttpServer());
    db = app.get(Db);
    const sms = app.get(SMS) as LoggedSmsAdapter;
    mock = sms.inner as MockSmsAdapter;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('logs each message with the code blanked', async () => {
    await http.post('/auth/otp/start').send({ phone: '08031110001' }).expect(200);
    const row = (await db.query(`select provider, phone, body, urgent, state from sms_log order by created_at desc limit 1`)).rows[0];
    expect(row).toEqual({ provider: 'mock', phone: '+2348031110001', body: 'Your ERP code is ••••••. It expires in 5 minutes. Never share it, not even with us.', urgent: true, state: 'sent' });
  });

  it('when the provider is down: says so, logs the failure, and lets the person ask again at once', async () => {
    mock.down = true;
    const r = await http.post('/auth/otp/start').send({ phone: '08031110002' }).expect(503);
    expect(r.body).toMatchObject({ code: 'sms_unavailable', message: 'We could not send the code just now. Try again in a minute, or call 112 if you are in danger.' });
    expect((await db.query(`select count(*)::int as n from otp_challenges where phone = '+2348031110002'`)).rows[0].n).toBe(0);
    expect((await db.query(`select state, error from sms_log where phone = '+2348031110002'`)).rows[0]).toEqual({ state: 'failed', error: 'SMS provider unavailable (mock)' });
    mock.down = false;
    // No resend wait for a code that never went out.
    await http.post('/auth/otp/start').send({ phone: '08031110002' }).expect(200);
  });
});
