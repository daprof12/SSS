// End-to-end: real NestJS app, real PostgreSQL/PostGIS, mock adapters.
// Needs the local database (npm run db:up). The suite resets the schema.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';

let app: INestApplication;
let http: ReturnType<typeof request>;
let baseUrl: string;
let db: Db;
const t: Record<string, string> = {};
let users: Record<string, string>;

const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await fn();
  }
  return v;
}

const view = async (who: string, id: string) => (await http.get(`/incidents/${id}`).set(as(who))).body;

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '150', PUBLIC_BASE_URL: 'http://erp.test' }));
  await app.listen(0);
  baseUrl = await app.getUrl();
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = await http.post('/dev/seed').expect(201);
  users = seed.body.users;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  t.headNoMfa = (await http.post('/dev/token').send({ userId: users.head, mfa: false }).expect(201)).body.token;
});

afterAll(async () => {
  await app?.close();
});

describe('auth', () => {
  it('rejects anonymous calls and staff without two-step login', async () => {
    await http.get('/me').expect(401);
    const r = await http.get('/me').set(as('headNoMfa')).expect(403);
    expect(r.body.code).toBe('mfa_required');
  });

  it('masks the phone on the profile', async () => {
    const r = await http.get('/me').set(as('citizen')).expect(200);
    expect(r.body.phone).toMatch(/•••/);
    expect(r.body.kyc.status).toBe('verified');
  });
});

describe('emergency report tracking (Report Tracking and Data Flow, Part A)', () => {
  let id: string;
  let joinerIncident: string;

  it('validates the report and never needs typing beyond type + location', async () => {
    const r = await http.post('/incidents').set(as('citizen')).send({ type: 'fire', clientRef: 'x' }).expect(400);
    expect(r.body.fields.map((f: any) => f.field)).toContain('clientRef');
  });

  it('adds an emergency contact (max 3, area-only link)', async () => {
    await http.post('/me/emergency-contacts').set(as('citizen')).send({ name: 'Mum', phone: '+2348099990001' }).expect(201);
    const bad = await http.post('/me/emergency-contacts').set(as('citizen')).send({ name: 'X', phone: '0803' }).expect(400);
    expect(bad.body.fields[0].message).toBe('Enter a Nigerian phone number.');
  });

  it('creates in the cancel window, then is received and offered to the nearest officer', async () => {
    const r = await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB 12C', clientRef: 'dev-ada-0001' }).expect(201);
    id = r.body.id;
    const first = await view('citizen', id);
    expect(first.state).toBe('pending_cancel');
    expect(first.status.title).toBe('Sending in 5');

    const again = await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: 'dev-ada-0001' }).expect(201);
    expect(again.body).toMatchObject({ id, duplicate: true });

    const offered = await waitFor(() => view('citizen', id), (v) => v.state === 'offered');
    expect(offered.status).toMatchObject({ title: 'Contacting the nearest station', step: 1 });
    expect(offered.actions).toEqual(['reporter_cancel']);
  });

  it('texts the emergency contact a link that shows the area only', async () => {
    const sms = (await http.get('/dev/sms')).body;
    const msg = sms.find((m: any) => m.to === '+2348099990001');
    expect(msg.body).toMatch(/^Ada asked for help\. Follow: http:\/\/erp\.test\/t\//);
    const token = msg.body.split('/t/')[1];
    const page = (await http.get(`/track/${token}`).expect(200)).body;
    expect(page).toMatchObject({ view: 'contact', status: 'finding_team', area: 'Maple area, Ikeja', reporterFirstName: 'Ada' });
    expect(JSON.stringify(page)).not.toMatch(/Maple Road|AB12C|Musa/);
    await http.get('/track/not-a-token').expect(404);
  });

  it('gives the offered officer the responder view without the reporter name', async () => {
    const v = await view('officer', id);
    expect(v.view).toBe('officer');
    expect(v.reporter).toEqual({ label: 'Verified citizen', trustBand: 'high', contact: 'masked_call' });
    expect(JSON.stringify(v)).not.toContain('Ada');
    expect(v.actions.sort()).toEqual(['accept', 'begin_close']);
  });

  it('hides the incident from people outside it', async () => {
    await http.get(`/incidents/${id}`).set(as('neighbour')).expect(404);
    await http.get(`/incidents/${id}`).set(as('officer2')).expect(404);
  });

  it('refuses "on scene" before accept with the final copy', async () => {
    const r = await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'arrive' }).expect(409);
    expect(r.body.message).toBe('You cannot mark this on scene before you accept.');
  });

  it('streams each change to the reporter as it happens (A6)', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/incidents/${id}/stream?access_token=${t.citizen}`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const read = (async () => {
      let buf = '';
      while (!seen.includes('accepted')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/"state":"([a-z_]+)"/g)) seen.push(m[1]!);
      }
    })();
    await sleep(100);
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'accept', etaMinutes: 7 }).expect(201);
    await Promise.race([read, sleep(3000)]);
    ctrl.abort();
    expect(seen).toContain('offered');
    expect(seen).toContain('accepted');
  });

  it('shows the officer card and ETA once on the way', async () => {
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'start_route', etaMinutes: 6 }).expect(201);
    const v = await view('citizen', id);
    expect(v.status).toMatchObject({ title: 'On the way', line: 'About 6 min.', holder: 'Insp. Musa Bello', showOfficerCard: true });
    expect(v.officer).toMatchObject({ name: 'Insp. Musa Bello', badgeNo: 'B-0477', stationName: 'Station 4 Ikeja' });
    expect(v.officerLocation).toBeDefined();
    expect(JSON.stringify(v)).not.toMatch(/brief|notes/);
  });

  it('merges a second report at the same building and tells both reporters', async () => {
    const r = await http.post('/incidents').set(as('neighbour')).send({ type: 'robbery', postcode: 'AB12C', clientRef: 'dev-chidi-0001' }).expect(201);
    joinerIncident = r.body.id;
    const own = await waitFor(() => view('neighbour', joinerIncident), (v) => v.state === 'merged');
    expect(own.mergedInto).toBe(id);
    const asJoiner = await view('neighbour', id);
    expect(asJoiner.view).toBe('joiner');
    expect(asJoiner.area).toBe('Maple area, Ikeja');
    expect(JSON.stringify(asJoiner)).not.toMatch(/Ada|12 Maple Road|AB12C/);
    const reporter = await view('citizen', id);
    expect(reporter.reportCount).toBe(2);
    expect(reporter.status.line).toMatch(/^You and 1 other person reported this\./);
  });

  it('keeps notes private and the station sees everything', async () => {
    await http.post(`/incidents/${id}/events`).set(as('officer')).send({ kind: 'note', text: 'Rear door forced' }).expect(201);
    await http.post(`/incidents/${id}/events`).set(as('officer')).send({ kind: 'note' }).expect(422);
    const st = await view('head', id);
    expect(st.view).toBe('station');
    expect(st.notes.map((n: any) => n.text)).toContain('Rear door forced');
    expect(JSON.stringify(await view('citizen', id))).not.toContain('Rear door');
  });

  it('stops sharing locations on scene and needs an outcome to close', async () => {
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'arrive' }).expect(201);
    const v = await view('citizen', id);
    expect(v.status.title).toBe('Help has arrived');
    expect(v.officerLocation).toBeUndefined();
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'begin_close' }).expect(201);
    const r = await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'close_valid' }).expect(422);
    expect(r.body.message).toBe('Choose an outcome before closing.');
    await http.post(`/incidents/${id}/actions`).set(as('officer')).send({ event: 'close_valid', outcomeCode: 'suspect_fled' }).expect(201);
    const done = await view('citizen', id);
    expect(done.status).toMatchObject({ title: 'Report closed', actions: ['rate'] });
    expect(done.timeline.map((e: any) => e.label)).toEqual(
      expect.arrayContaining(['Report received', 'Help accepted', 'On the way', 'Help has arrived', 'Report closed']),
    );
  });

  it('re-offers to the next officer when one declines', async () => {
    const r = await http.post('/incidents').set(as('citizen')).send({ type: 'riot', postcode: 'EF56G', clientRef: 'dev-ada-0002' }).expect(201);
    const second = r.body.id;
    await waitFor(() => view('citizen', second), (v) => v.state === 'offered');
    const who = (await view('officer', second).catch(() => null))?.view === 'officer' ? 'officer' : 'officer2';
    const other = who === 'officer' ? 'officer2' : 'officer';
    const bad = await http.post(`/incidents/${second}/decline`).set(as(who)).send({ reason: 'nah' }).expect(422);
    expect(bad.body.message).toBe('A reason is required: busy, too far, off duty, other.');
    await http.post(`/incidents/${second}/decline`).set(as(who)).send({ reason: 'too_far' }).expect(201);
    const v = await waitFor(() => view(other, second).catch(() => ({})), (x: any) => x.view === 'officer');
    expect(v.state).toBe('offered');
    await http.get(`/incidents/${second}`).set(as(who)).expect(404);
    const c = await http.post(`/incidents/${second}/cancel`).set(as('citizen')).send({ reason: 'mistake' }).expect(201);
    expect(c.body).toMatchObject({ state: 'cancelled', flagged: true });
  });

  it('lists my reports with open ones first', async () => {
    const r = await http.get('/me/incidents').set(as('citizen')).expect(200);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    expect(r.body[0]).toHaveProperty('status');
  });

  it('wrote an intact, append-only audit trail', async () => {
    expect((await db.query('select audit_verify() as b')).rows[0].b).toBeNull();
    await expect(db.query('update incident_events set kind = kind')).rejects.toThrow(/append-only/);
  });
});

describe('station actions (Gap Analysis S-1)', () => {
  let id: string;

  it('keeps a report with the station when nobody is free, then lets the head assign one', async () => {
    await db.query(`update officers set on_duty = false`);
    const r = await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'GH78J', clientRef: 'dev-ada-0010' }).expect(201);
    id = r.body.id;
    const waiting = await waitFor(() => view('head', id).catch(() => ({})), (v: any) => v.state === 'received' && v.view === 'station');
    expect(waiting.actions).toContain('assign');

    const list = (await http.get(`/me/station/officers?near=${id}`).set(as('head')).expect(200)).body;
    expect(list.every((o: any) => o.available === false)).toBe(true);
    const off = await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users.officer2 }).expect(422);
    expect(off.body.message).toBe('This officer is off duty.');

    await db.query(`update officers set on_duty = true where user_id = $1`, [users.officer2]);
    const free = (await http.get(`/me/station/officers?near=${id}`).set(as('head')).expect(200)).body;
    expect(free.find((o: any) => o.id === users.officer2)).toMatchObject({ available: true, distanceM: expect.any(Number) });

    expect((await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users.officer2 }).expect(201)).body).toMatchObject({ state: 'offered' });
    expect((await view('officer2', id)).view).toBe('officer');
    expect((await view('citizen', id)).timeline.map((e: any) => e.label)).toContain('Sent to a team');
  });

  it('refuses assign from non-station staff and for officers of another station', async () => {
    await http.post(`/incidents/${id}/assign`).set(as('citizen')).send({ officerId: users.officer2 }).expect(403);
    await http.get('/me/station/officers').set(as('officer')).expect(403);
  });

  it('lists other stations and transfers with a reason', async () => {
    expect((await http.get('/me/station/transfer-targets').set(as('head')).expect(200)).body).toEqual([]);
    const ag = (await db.query(`insert into agencies (name, kind, status, period_start, period_end) values ('Fire Service (test)', 'fire', 'live', current_date, current_date + 30) returning id`)).rows[0].id;
    const st = (await db.query(`insert into stations (agency_id, name, status) values ($1, 'Fire Station 2', 'active') returning id`, [ag])).rows[0].id;
    const targets = (await http.get('/me/station/transfer-targets').set(as('head')).expect(200)).body;
    expect(targets).toEqual([expect.objectContaining({ id: st, name: 'Fire Station 2', agency: 'Fire Service (test)' })]);

    await http.post(`/incidents/${id}/actions`).set(as('head')).send({ event: 'transfer', targetStationId: st }).expect(422);
    await http.post(`/incidents/${id}/actions`).set(as('head')).send({ event: 'transfer', targetStationId: st, reason: 'Needs another service' }).expect(201);
    // The head no longer holds it; the reporter sees who has it now.
    await http.get(`/incidents/${id}`).set(as('head')).expect(404);
    const v = await view('citizen', id);
    expect(['transferred', 'offered', 'received']).toContain(v.state);
    expect(v.timeline.map((e: any) => e.label)).toContain('Passed to another unit');
    await db.query(`update officers set on_duty = true`);
  });
});

describe('fund wallet (UX Gap Analysis §9)', () => {
  it('requires an idempotency key and validates the amount', async () => {
    await http.post('/me/wallet/fund').set(as('citizen')).send({ amountKobo: 500000, method: 'card' }).expect(400);
    const r = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-min-0001').send({ amountKobo: 5000, method: 'card' }).expect(422);
    expect(r.body.message).toBe('Enter an amount of at least ₦100.00.');
  });

  it('blocks unverified users', async () => {
    const u = (await db.query(`insert into users (phone, display_name) values ('+2348030000099', 'New User') returning id`)).rows[0].id;
    const tok = (await http.post('/dev/token').send({ userId: u })).body.token;
    const r = await http.post('/me/wallet/fund').set({ Authorization: `Bearer ${tok}` }).set('Idempotency-Key', 'k-kyc-0001').send({ amountKobo: 500000, method: 'card' }).expect(403);
    expect(r.body.code).toBe('kyc_required');
  });

  it('credits only after the signed webhook, once', async () => {
    const start = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-card-0001').send({ amountKobo: 500000, method: 'card' }).expect(201);
    expect(start.body).toMatchObject({ state: 'pending', amount: '₦5,000.00' });
    expect(start.body.checkoutUrl).toContain('/dev/paystack/checkout/');
    const ref = start.body.reference;

    const replay = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-card-0001').send({ amountKobo: 500000, method: 'card' }).expect(201);
    expect(replay.body).toMatchObject({ reference: ref, replayed: true });

    expect((await http.get(`/me/payments/${ref}`).set(as('citizen'))).body.message).toBe('Confirming your payment.');
    expect((await http.get('/me/wallet').set(as('citizen'))).body.availableKobo).toBe(0);

    await http.post(`/dev/paystack/complete/${ref}`).expect(201);
    const st = (await http.get(`/me/payments/${ref}`).set(as('citizen'))).body;
    expect(st).toMatchObject({ state: 'succeeded', message: '₦5,000.00 was added to your wallet.' });
    const w = (await http.get('/me/wallet').set(as('citizen'))).body;
    expect(w).toMatchObject({ availableKobo: 500000, available: '₦5,000.00' });
    expect(w.entries[0]).toMatchObject({ type: 'fund', amount: '+₦5,000.00' });
  });

  it('ignores a replayed webhook and rejects a forged one', async () => {
    const start = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-card-0002').send({ amountKobo: 100000, method: 'ussd' }).expect(201);
    const { MockPaystackAdapter, PAYMENTS } = await import('../src/adapters/payments').then((m) => ({ MockPaystackAdapter: m.MockPaystackAdapter, PAYMENTS: m.PAYMENTS }));
    const mock = app.get(PAYMENTS) as InstanceType<typeof MockPaystackAdapter>;
    const { body, signature } = mock.buildWebhook(start.body.reference, 'success');
    const send = (sig: string) => http.post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body);
    await send('00'.repeat(64)).expect(401);
    expect((await send(signature).expect(200)).body).toEqual({ ok: true });
    expect((await send(signature).expect(200)).body).toEqual({ ok: true, duplicate: true });
    expect((await http.get('/me/wallet').set(as('citizen'))).body.availableKobo).toBe(600000);
  });

  it('credits what actually arrives by bank transfer, and reports failures plainly', async () => {
    const tr = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-bank-0001').send({ amountKobo: 1000000, method: 'bank_transfer' }).expect(201);
    expect(tr.body.transferAccount).toMatchObject({ bankName: expect.any(String), accountNumber: expect.stringMatching(/^\d{10}$/) });
    await http.post(`/dev/paystack/complete/${tr.body.reference}?amount=900000`).expect(201);
    expect((await http.get('/me/wallet').set(as('citizen'))).body.availableKobo).toBe(1500000);

    const f = await http.post('/me/wallet/fund').set(as('citizen')).set('Idempotency-Key', 'k-fail-0001').send({ amountKobo: 200000, method: 'card' }).expect(201);
    await http.post(`/dev/paystack/complete/${f.body.reference}?outcome=failed`).expect(201);
    expect((await http.get(`/me/payments/${f.body.reference}`).set(as('citizen'))).body).toMatchObject({
      state: 'failed',
      message: 'Your card was not charged. Try again or use another card.',
    });
  });

  it('blocks account deletion while money is in the wallet', async () => {
    const r = (await http.get('/me/deletion-check').set(as('citizen')).expect(200)).body;
    expect(r.canDelete).toBe(false);
    expect(r.blockers[0]).toMatchObject({ code: 'wallet_balance', action: '/wallet/withdraw' });
    expect(r.blockers[0].message).toMatch(/₦15,000\.00/);
  });
});

describe('places and KYC adapters', () => {
  it('cascades the five location levels', async () => {
    const states = (await http.get('/places/levels/state').set(as('citizen')).expect(200)).body;
    expect(states.map((s: any) => s.name)).toContain('Lagos');
    await http.get('/places/levels/lga').set(as('citizen')).expect(422);
    const lgas = (await http.get('/places/levels/lga?parent=LA').set(as('citizen')).expect(200)).body;
    expect(lgas.map((s: any) => s.name)).toContain('Ikeja');
  });

  it('never blocks a report when the postcode service is down', async () => {
    await http.post('/dev/postcode/down?down=1').expect(201);
    try {
      await http.get('/places/lookup?postcode=AB12C').set(as('citizen')).expect(503);
      const r = await http.post('/incidents').set(as('citizen')).send({ type: 'medical', lat: 6.6018, lng: 3.3515, clientRef: 'dev-ada-0003' }).expect(201);
      expect(r.body.addressWarning).toMatch(/not responding/);
      await http.post(`/incidents/${r.body.id}/cancel`).set(as('citizen')).send({ reason: 'mistake' }).expect(201);
    } finally {
      await http.post('/dev/postcode/down?down=0');
    }
  });

  it('stores only a masked ID and locks after three failures', async () => {
    const body = { idType: 'nin', firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', liveness: true };
    const ok = await http.post('/me/kyc').set(as('technician')).send({ ...body, idNumber: '12345678901' }).expect(201);
    expect(ok.body).toEqual({ status: 'verified', idMasked: '•••••••8901' });
    const rows = (await db.query(`select * from kyc_verifications where provider_ref like 'mock_kyc_%'`)).rows;
    expect(JSON.stringify(rows)).not.toContain('12345678901');
    for (let i = 0; i < 3; i++) {
      const r = await http.post('/me/kyc').set(as('neighbour')).send({ ...body, idNumber: '12345671111' }).expect(201);
      expect(r.body.message).toBe('We could not match your details to this ID. Check the spelling and try again.');
    }
    const locked = await http.post('/me/kyc').set(as('neighbour')).send({ ...body, idNumber: '12345678901' }).expect(429);
    expect(locked.body.message).toBe('We could not verify you. Visit a verification point or contact support.');
  });
});
