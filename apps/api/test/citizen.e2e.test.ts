// Citizen profile and home: security, donations, receipts, fines and appeals, help, household, devices, repairs.
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
let stationId: string;
let agencyId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const key = () => `ck-${Date.now()}-${++n}`;
const ref = () => `cz-${Date.now()}-${++n}`;
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
const lastSms = async (phone: string) => (await http.get('/dev/sms')).body.filter((m: any) => m.to === phone).pop();

/** A robbery the officer reaches and closes; `unfounded` marks it a false alarm. */
async function closeReport(reporter: string, unfounded: boolean) {
  const id = (await http.post('/incidents').set(as(reporter)).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
  await waitFor(() => view(reporter, id), (x) => x.state === 'offered');
  let lead = '';
  for (const w of ['officer', 'officer2']) if ((await view(w, id)).view === 'officer') lead = w;
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'accept' }).expect(201);
  for (const event of ['start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event }).expect(201);
  await http
    .post(`/incidents/${id}/actions`)
    .set(as(lead))
    .send(unfounded ? { event: 'close_unfounded', outcomeCode: 'no_incident', reason: 'Nobody at the address, no sign of a robbery.' } : { event: 'close_valid', outcomeCode: 'arrest' })
    .expect(201);
  return { id, lead };
}

async function fund(who: string, naira: number) {
  const f = (await http.post('/me/wallet/fund').set(as(who)).set('Idempotency-Key', key()).send({ amountKobo: naira * 100, method: 'card' }).expect(201)).body;
  await http.post(`/dev/paystack/complete/${f.reference}`).expect(201);
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
  agencyId = seed.agencyId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [stationId, u, lng, lat]);
  }
  await http.put('/me/pin').set(as('citizen')).send({ pin: '7302' }).expect(200);
});
afterAll(async () => {
  await app?.close();
});

describe('security', () => {
  it('turns two-step login on with an SMS code, gives recovery codes once, and off again', async () => {
    let s = (await http.get('/me/security').set(as('citizen')).expect(200)).body;
    expect(s).toMatchObject({ twoStep: { on: false, required: false }, pin: { set: true }, biometrics: { on: false, payments: true }, recoveryCodes: { left: 0 } });
    await http.post('/me/security/code').set(as('citizen')).expect(201);
    const code = /(\d{6})/.exec((await lastSms('+2348030000001')).body)![1]!;
    expect((await http.post('/me/security/2fa').set(as('citizen')).send({ code: code === '000000' ? '111111' : '000000' }).expect(400)).body.message).toBe('That code is not right. 4 tries left.');
    const on = (await http.post('/me/security/2fa').set(as('citizen')).send({ code }).expect(201)).body;
    expect(on.recoveryCodes).toHaveLength(10);
    expect(on.recoveryCodes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    s = (await http.get('/me/security').set(as('citizen'))).body;
    expect(s).toMatchObject({ twoStep: { on: true }, recoveryCodes: { left: 10, generated: true } });

    await http.patch('/me/security/biometrics').set(as('citizen')).send({ on: true, signing: false }).expect(200);
    expect((await http.get('/me/security').set(as('citizen'))).body.biometrics).toMatchObject({ on: true, openApp: true, signing: false, payments: true });

    // Staff cannot turn it off.
    expect((await http.post('/me/security/2fa/off').set(as('officer')).send({ code: '123456' }).expect(409)).body.message).toBe('Two-step login is required for your role and cannot be turned off.');
    await db.query(`delete from otp_challenges where phone = '+2348030000001'`); // skip the resend wait
    await http.post('/me/security/code').set(as('citizen')).expect(201);
    const off = /(\d{6})/.exec((await lastSms('+2348030000001')).body)![1]!;
    await http.post('/me/security/2fa/off').set(as('citizen')).send({ code: off }).expect(201);
    expect((await http.get('/me/security').set(as('citizen'))).body).toMatchObject({ twoStep: { on: false }, recoveryCodes: { left: 0 } });
  });
});

describe('fines and appeals', () => {
  let fineId = '';
  it('warns on the first false alarm, fines on the second, and lowers trust each time', async () => {
    const start = (await http.get('/me/fines').set(as('citizen'))).body.trust.score;
    await closeReport('citizen', true);
    let me = (await http.get('/me/fines').set(as('citizen')).expect(200)).body;
    expect(me.fines).toHaveLength(0);
    expect(me.warnings).toHaveLength(1);
    expect(me.trust.score).toBe(start - 5);
    const warn = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'false_alarm_warning');
    expect(warn.body).toMatch(/This is a warning, not a fine\./);

    await closeReport('citizen', true);
    me = (await http.get('/me/fines').set(as('citizen'))).body;
    expect(me.fines).toHaveLength(1);
    expect(me.trust.score).toBe(start - 15);
    const f = me.fines[0];
    fineId = f.id;
    expect(f).toMatchObject({ state: 'open', amountKobo: 500000, dueKobo: 500000, trustDelta: -10, canAppeal: true, canPay: true, reason: 'No incident found on arrival' });
    expect(f.number).toMatch(/^F-\d{6}$/);
    expect(f.report.label).toMatch(/^Robbery, AB12C, /);
    expect(f.banner.line).toMatch(/^Fine ₦5,000\.00\. Appeal within 14 days or it is due on /);
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'fine_issued');
    expect(note.body).toMatch(/The fine is ₦5,000\.00\. You can appeal within 14 days\.$/);
  });

  it('takes an appeal of 20 characters or more, and blocks paying while it is reviewed', async () => {
    expect((await http.post(`/me/fines/${fineId}/appeal`).set(as('citizen')).send({ reason: 'It was real' }).expect(422)).body.message).toBe('Tell us why in at least 20 characters.');
    const a = (await http.post(`/me/fines/${fineId}/appeal`).set(as('citizen')).send({ reason: 'The robbers ran before the officer arrived, my neighbour saw them.' }).expect(201)).body;
    expect(a).toMatchObject({ state: 'appealed', message: 'Appeal sent. We will tell you the decision.' });
    await http.post(`/me/fines/${fineId}/appeal`).set(as('citizen')).send({ reason: 'Again, the robbers ran away before.' }).expect(409);
    expect((await http.post(`/me/fines/${fineId}/pay`).set(as('citizen')).set('Idempotency-Key', key()).send({ method: 'wallet', pin: '7302' }).expect(409)).body.message).toBe('Wait for the appeal decision before paying.');
    await http.get(`/me/fines/${fineId}`).set(as('neighbour')).expect(404);
  });

  it('lets the platform admin reduce it, and the citizen pays from the wallet with a receipt', async () => {
    await http.get('/admin/fines').set(as('citizen')).expect(403);
    const q = (await http.get('/admin/fines').set(as('platformAdmin')).expect(200)).body;
    expect(q.items[0]).toMatchObject({ id: fineId, state: 'appealed', citizen: 'Ada Obi' });
    expect((await http.post(`/admin/fines/${fineId}/decision`).set(as('platformAdmin')).send({ decision: 'reduce', reason: 'Partly accepted.', amountKobo: 600000 }).expect(422)).body.message).toBe('Enter an amount below ₦5,000.00.');
    await http.post(`/admin/fines/${fineId}/decision`).set(as('platformAdmin')).send({ decision: 'reduce', reason: 'Your neighbour confirmed part of it.', amountKobo: 200000 }).expect(201);
    expect((await http.get(`/me/fines/${fineId}`).set(as('citizen'))).body).toMatchObject({ state: 'reduced', dueKobo: 200000, canPay: true });

    expect((await http.post(`/me/fines/${fineId}/pay`).set(as('citizen')).set('Idempotency-Key', key()).send({ method: 'wallet', pin: '7302' }).expect(422)).body.message).toBe('Your wallet has ₦0.00. Top up ₦2,000.00 or pay by card.');
    await fund('citizen', 10_000);
    const k = key();
    const paid = (await http.post(`/me/fines/${fineId}/pay`).set(as('citizen')).set('Idempotency-Key', k).send({ method: 'wallet', pin: '7302' }).expect(201)).body;
    expect(paid.receiptNo).toMatch(/^R-\d{6}$/);
    // A double tap pays once.
    expect((await http.post(`/me/fines/${fineId}/pay`).set(as('citizen')).set('Idempotency-Key', k).send({ method: 'wallet', pin: '7302' }).expect(201)).body.replayed).toBe(true);
    expect((await http.get(`/me/fines/${fineId}`).set(as('citizen'))).body.state).toBe('paid');
    expect((await http.get('/me/wallet').set(as('citizen'))).body.availableKobo).toBe(800_000);

    const r = (await http.get(`/me/receipts/${paid.reference}`).set(as('citizen')).expect(200)).body;
    expect(r).toMatchObject({ what: 'Fine', amountKobo: 200000, method: 'Wallet', to: 'ERP platform', state: 'succeeded' });
    expect(r.detail).toMatch(/^Fine F-\d{6}$/);
  });

  it('waiving a fine gives the trust points back', async () => {
    await closeReport('citizen', true);
    const f = (await http.get('/me/fines').set(as('citizen'))).body.fines.find((x: any) => x.state === 'open');
    const before = (await http.get('/me/fines').set(as('citizen'))).body.trust.score;
    await http.post(`/admin/fines/${f.id}/decision`).set(as('platformAdmin')).send({ decision: 'waive', reason: 'Our mistake, sorry.' }).expect(201);
    const after = (await http.get('/me/fines').set(as('citizen'))).body;
    expect(after.trust.score).toBe(before + 10);
    expect(after.fines.find((x: any) => x.id === f.id).banner.title).toBe('Fine waived');
  });
});

describe('donations and receipts', () => {
  it('lists who to support, including the officer who helped', async () => {
    await closeReport('neighbour', false);
    const tg = (await http.get('/me/donate/targets').set(as('neighbour')).expect(200)).body;
    expect(tg.presetsKobo).toEqual([50000, 100000, 200000]);
    expect(tg.agencies.find((a: any) => a.id === agencyId)).toBeTruthy();
    expect(tg.stations[0]).toMatchObject({ id: stationId });
    expect(tg.stations[0].sub).toMatch(/helped you$/);
    expect(tg.officers.length).toBe(1);
    expect(tg.officers[0].sub).toMatch(/responded to your robbery report$/);
  });

  it('gives to a station from the wallet, split by the agency shares, officers held 7 days', async () => {
    await http.put('/me/pin').set(as('neighbour')).send({ pin: '7302' }).expect(200);
    await fund('neighbour', 5_000);
    const body = { targetType: 'station', targetId: stationId, amountKobo: 100000, method: 'wallet', showName: true, pin: '7302' };
    expect((await http.post('/me/donations').set(as('neighbour')).set('Idempotency-Key', key()).send({ ...body, amountKobo: 5000 }).expect(422)).body.message).toBe('Give at least ₦100.00.');
    expect((await http.post('/me/donations').set(as('neighbour')).set('Idempotency-Key', key()).send({ ...body, pin: '1111' }).expect(422)).body.code).toBe('pin_wrong');
    const d = (await http.post('/me/donations').set(as('neighbour')).set('Idempotency-Key', key()).send(body).expect(201)).body;
    expect(d.message).toBe('Thank you. ₦1,000.00 went to Station 4 Ikeja.');
    // 50% to the two officers (₦250 each, held), 30% to the station, 20% to the agency.
    const legs = (await db.query(`select shares from donations where id = (select purpose_ref from payments where provider_ref = $1)`, [d.reference])).rows[0].shares;
    expect(legs.filter((l: any) => l.to === 'officer').map((l: any) => l.kobo)).toEqual([25000, 25000]);
    expect(legs.find((l: any) => l.to === 'station').kobo).toBe(30000);
    expect(legs.find((l: any) => l.to === 'agency').kobo).toBe(20000);
    const officerWallet = (await http.get('/me/wallet').set(as('officer'))).body;
    expect(officerWallet.heldKobo).toBeGreaterThanOrEqual(25000);
    const note = (await http.get('/me/notifications').set(as('officer'))).body.items.find((x: any) => x.type === 'donation_received');
    expect(note.body).toBe('Chidi Neighbour gave ₦250.00 to your station; this is your share. Released in 7 days.');
  });

  it('gives to a named officer by Paystack; the webhook credits it and the receipt shows it', async () => {
    const start = (await http.post('/me/donations').set(as('neighbour')).set('Idempotency-Key', key()).send({ targetType: 'officer', targetId: users.officer, amountKobo: 200000, method: 'card', showName: false }).expect(201)).body;
    expect(start.checkoutUrl).toBeTruthy();
    await http.post(`/dev/paystack/complete/${start.reference}`).expect(201);
    const pay = (await http.get(`/me/payments/${start.reference}`).set(as('neighbour'))).body;
    expect(pay).toMatchObject({ state: 'succeeded', purpose: 'donation', message: 'Thank you. Your donation of ₦2,000.00 was received.' });
    const list = (await http.get('/me/payments?tab=donations').set(as('neighbour')).expect(200)).body;
    expect(list.items.map((x: any) => x.what)).toEqual(['Donation', 'Donation']);
    expect(list.totalPaidKobo).toBe(300000);
    const r = (await http.get(`/me/receipts/${start.reference}`).set(as('neighbour'))).body;
    expect(r).toMatchObject({ what: 'Donation', method: 'Card', to: 'Insp. Musa Bello', detail: 'Given without your name.' });
    expect((await http.get('/me/donations').set(as('neighbour'))).body[0]).toMatchObject({ target: 'Insp. Musa Bello', state: 'paid' });
    await http.get(`/me/receipts/${start.reference}`).set(as('citizen')).expect(404);
  });
});

describe('help and support', () => {
  it('shows answers and takes a message with a reference', async () => {
    const s = (await http.get('/me/support').set(as('citizen')).expect(200)).body;
    expect(s.faq.length).toBeGreaterThan(3);
    expect(s.emergency.number).toBe('112');
    expect((await http.post('/me/support/tickets').set(as('citizen')).send({ topic: 'app', body: 'short' }).expect(400)).body.fields[0].message).toBe('Tell us a little more, at least 10 characters.');
    const r = (await http.post('/me/support/tickets').set(as('citizen')).send({ topic: 'money', body: 'My withdrawal has not arrived yet.' }).expect(201)).body;
    expect(r.number).toMatch(/^S-\d{6}$/);
    expect((await http.get('/me/support').set(as('citizen'))).body.tickets[0]).toMatchObject({ number: r.number, state: 'open' });
  });
});

describe('home: household, devices and repairs', () => {
  it('shows the home, plan and devices with an alert for the offline camera', async () => {
    const h = (await http.get('/me/home').set(as('citizen')).expect(200)).body;
    expect(h.home).toMatchObject({ role: 'owner', address: '12 Maple Road', postcode: 'AB12C', plan: { name: 'Household', state: 'active', label: 'Active' } });
    expect(h.devices.map((d: any) => [d.name, d.status])).toEqual([
      ['Front gate camera', 'online'],
      ['Back gate camera', 'offline'],
      ['Street light, Maple Road', 'online'],
      ['Street light, junction', 'low_power'],
    ]);
    expect(h.devices[1].line).toBe('Last seen 5 hours ago');
    expect(h.devices[3].line).toBe('Battery 18%');
    expect(h.alert).toMatchObject({ title: 'Back gate camera is offline' });
    expect((await http.get('/me/home').set(as('neighbour'))).body.home).toBeNull();
  });

  it('invites by phone, refuses someone already in a household, and the invitee accepts', async () => {
    const inv = (p: Record<string, unknown>) => http.post('/me/home/invites').set(as('citizen')).send({ viewLive: true, alerts: true, report: false, ...p });
    expect((await inv({ phone: '12345' }).expect(422)).body.message).toBe('Enter a Nigerian phone number.');
    expect((await inv({ phone: '+2348030000001' }).expect(422)).body.message).toBe('That is your own number.');
    expect((await inv({ phone: '08030000008' }).expect(201)).body.message).toBe('Invite sent to Chidi Neighbour.');
    expect((await inv({ phone: '+2348030000008' }).expect(422)).body.message).toBe('You already invited this number. They can accept it in the app.');
    let hh = (await http.get('/me/home/household').set(as('citizen'))).body;
    expect(hh.people.map((x: any) => [x.name, x.role])).toEqual([
      ['You', 'owner'],
      ['+2348030000008', 'invited'],
    ]);
    const incoming = (await http.get('/me/home').set(as('neighbour'))).body.incoming;
    expect(incoming[0]).toMatchObject({ from: 'Ada Obi', address: '12 Maple Road', can: { viewLive: true, alerts: true, report: false } });
    await http.post(`/me/home/invites/${incoming[0].id}/answer`).set(as('neighbour')).send({ accept: true }).expect(200);
    hh = (await http.get('/me/home/household').set(as('citizen'))).body;
    expect(hh.people.map((x: any) => [x.name, x.role])).toEqual([
      ['You', 'owner'],
      ['Chidi Neighbour', 'member'],
    ]);
    // Now a member, so another home's invite is refused with their name.
    const member = (await http.get('/me/home').set(as('neighbour'))).body.home;
    expect(member).toMatchObject({ role: 'member', permissions: { viewLive: true, report: false } });
    // A member cannot invite.
    await http.post('/me/home/invites').set(as('neighbour')).send({ phone: '+2348030000009', viewLive: true, alerts: true, report: false }).expect(403);
  });

  it('shows a camera with its settings and clips, and the offline camera with steps to try', async () => {
    const devices = (await http.get('/me/home').set(as('citizen'))).body.devices;
    const front = (await http.get(`/me/devices/${devices[0].id}`).set(as('citizen')).expect(200)).body;
    expect(front).toMatchObject({ type: 'camera', status: 'online', canViewLive: true, settings: { recordingDays: 7, shareWithResponders: 'emergency_only' }, viewers: 2, offlineSteps: [] });
    await http.post(`/me/devices/${devices[0].id}/clips`).set(as('citizen')).expect(201);
    expect((await http.get(`/me/devices/${devices[0].id}`).set(as('citizen'))).body.clips[0]).toMatchObject({ kind: 'clip', label: 'Saved clip', seconds: 30 });
    await http.patch(`/me/devices/${devices[0].id}/settings`).set(as('citizen')).send({ recordingDays: 14 }).expect(200);
    await http.patch(`/me/devices/${devices[0].id}/settings`).set(as('neighbour')).send({ recordingDays: 3 }).expect(403);
    const back = (await http.get(`/me/devices/${devices[1].id}`).set(as('citizen'))).body;
    expect(back.offlineSteps).toHaveLength(3);
    expect(back.lastSeenText).toMatch(/^Last seen 5 hours ago, \d\d:\d\d$/);
    expect((await http.post(`/me/devices/${devices[1].id}/clips`).set(as('citizen')).expect(409)).body.message).toBe('The camera is offline, so there is nothing to save.');
  });

  it('lights up the street for an hour, twice a night at most', async () => {
    const light = (await http.get('/me/home').set(as('citizen'))).body.devices[2];
    const v = (await http.get(`/me/devices/${light.id}`).set(as('citizen'))).body;
    expect(v).toMatchObject({ type: 'street_light', now: 'On, dusk to dawn', power: 'Solar, battery 86%', lowBattery: false, boost: { usedTonight: 0, limit: 2 } });
    expect((await http.post(`/me/devices/${light.id}/boost`).set(as('citizen')).expect(201)).body.message).toMatch(/^The street light is on until \d\d:\d\d\.$/);
    await http.post(`/me/devices/${light.id}/boost`).set(as('neighbour')).expect(201);
    expect((await http.post(`/me/devices/${light.id}/boost`).set(as('citizen')).expect(429)).body.message).toBe('You can do this 2 times a night. If you feel unsafe, report an emergency.');
  });

  it('reports a device problem and follows the repair to a confirmed fix', async () => {
    const back = (await http.get('/me/home').set(as('citizen'))).body.devices[1];
    const rep = (b: Record<string, unknown>) => http.post('/me/repairs').set(as('citizen')).send({ deviceId: back.id, ...b });
    expect((await rep({ problem: 'offline', description: 'dead' }).expect(422)).body.message).toBe('Add at least a few words so the team knows what to bring.');
    await http.post('/me/repairs').set(as('neighbour')).send({ deviceId: back.id, problem: 'offline', description: 'It has been off since yesterday evening.' }).expect(403);
    const r = (await rep({ problem: 'offline', description: 'It has been off since yesterday evening.', bestTime: 'Weekday mornings' }).expect(201)).body;
    expect(r.number).toMatch(/^RP-\d{6}$/);
    expect((await rep({ problem: 'offline', description: 'Still off since yesterday evening.' }).expect(409)).body.message).toBe(`A repair for this device is already open: ${r.number}.`);

    let s = (await http.get(`/me/repairs/${r.id}`).set(as('citizen')).expect(200)).body;
    expect(s).toMatchObject({ step: 'received', chip: 'Reported', device: 'Back gate camera', problem: 'Offline', cost: 'Free, covered by your plan', canConfirm: false });
    expect(s.steps.map((x: any) => x.state)).toEqual(['current', 'next', 'next', 'next']);

    const adm = (await http.get('/admin/repairs').set(as('platformAdmin')).expect(200)).body;
    expect(adm.items.find((x: any) => x.id === r.id)).toMatchObject({ owner: 'Ada Obi', bestTime: 'Weekday mornings', step: 'received' });
    await http.post(`/admin/repairs/${r.id}`).set(as('platformAdmin')).send({ action: 'confirm_fault' }).expect(200);
    await http.post(`/admin/repairs/${r.id}`).set(as('platformAdmin')).send({ action: 'fixed' }).expect(409);
    await http.post(`/admin/repairs/${r.id}`).set(as('platformAdmin')).send({ action: 'book', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), window: '9am to 12pm' }).expect(200);
    s = (await http.get(`/me/repairs/${r.id}`).set(as('citizen'))).body;
    expect(s).toMatchObject({ step: 'booked', chip: 'Visit booked', technician: 'Tunde Tech, verified badge' });
    expect(s.visit).toMatch(/, 9am to 12pm$/);
    const booked = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.title === 'Visit booked');
    expect(booked.body).toMatch(/Tunde Tech visits on .+, 9am to 12pm\. They show a badge and a code; never let anyone in without both\.$/);

    // Changing the time sends it back to be rebooked.
    expect((await http.post(`/me/repairs/${r.id}/time`).set(as('citizen')).send({ bestTime: 'Saturday afternoon' }).expect(200)).body.message).toBe('Asked for a new time. We will book it and tell you.');
    expect((await http.get(`/me/repairs/${r.id}`).set(as('citizen'))).body.step).toBe('confirmed');
    await http.post(`/admin/repairs/${r.id}`).set(as('platformAdmin')).send({ action: 'book', scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), window: '2pm to 5pm' }).expect(200);
    await http.post(`/admin/repairs/${r.id}`).set(as('platformAdmin')).send({ action: 'fixed' }).expect(200);
    s = (await http.get(`/me/repairs/${r.id}`).set(as('citizen'))).body;
    expect(s).toMatchObject({ step: 'fixed', canConfirm: true });
    expect((await http.get(`/me/devices/${back.id}`).set(as('citizen'))).body.status).toBe('online');
    await http.post(`/me/repairs/${r.id}/confirm`).set(as('citizen')).send({ fixed: true }).expect(200);
    expect((await http.get(`/me/repairs/${r.id}`).set(as('citizen'))).body).toMatchObject({ step: 'closed', chip: 'Closed' });
  });

  it('treats damage as urgent and tells the station', async () => {
    const light = (await http.get('/me/home').set(as('citizen'))).body.devices[3];
    const r = (await http.post('/me/repairs').set(as('citizen')).send({ deviceId: light.id, problem: 'damaged', description: 'Someone bent the pole last night.' }).expect(201)).body;
    expect(r).toMatchObject({ urgent: true });
    expect(r.message).toMatch(/We have told your local station\.$/);
    const head = (await http.get('/me/notifications').set(as('head'))).body.items.find((x: any) => x.type === 'device_tamper');
    expect(head.body).toBe('A camera or light at AB12C may have been damaged or moved. The owner reported it.');
  });
});

describe('officer dispatch', () => {
  it('declines with a reason, never re-offers to who passed, and shows who took it', async () => {
    const id = (await http.post('/incidents').set(as('citizen')).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    await waitFor(() => view('citizen', id), (x) => x.state === 'offered');
    let first = '';
    for (const w of ['officer', 'officer2']) if ((await view(w, id)).view === 'officer') first = w;
    const second = first === 'officer' ? 'officer2' : 'officer';
    const o = (await http.get(`/incidents/${id}/offer`).set(as(first)).expect(200)).body;
    expect(o).toMatchObject({ state: 'offered', report: { label: 'Robbery, AB12C' }, takenBy: null });
    expect(o.secondsLeft).toBeGreaterThan(0);

    await http.post(`/incidents/${id}/decline`).set(as(first)).send({ reason: 'busy' }).expect(201);
    await waitFor(() => http.get(`/incidents/${id}/offer`).set(as(second)).then((r) => r.status), (s) => s === 200);
    expect((await http.get(`/incidents/${id}/offer`).set(as(first))).body).toMatchObject({ state: 'declined', counted: true });
    await http.post(`/incidents/${id}/decline`).set(as(second)).send({ reason: 'too_far' }).expect(201);
    // Nobody left who has not passed: the first officer is never offered it again.
    const units = (await db.query(`select officer_id, state from incident_units where incident_id = $1 order by offered_at`, [id])).rows;
    expect(units.map((u) => u.state)).toEqual(['declined', 'declined']);

    // The station head assigns the first officer again by hand; they accept, and the second sees who took it.
    await http.post(`/incidents/${id}/assign`).set(as('head')).send({ officerId: users[first] }).expect(201);
    await http.post(`/incidents/${id}/actions`).set(as(first)).send({ event: 'accept' }).expect(201);
    expect((await http.get(`/incidents/${id}/offer`).set(as(second))).body).toMatchObject({ state: 'declined', takenBy: { station: 'Station 4 Ikeja' }, counted: true });
    expect((await http.get('/me/officer/profile').set(as(second))).body.acceptance).toMatchObject({ declined: 1 });

    // The staff log shows who did what, the citizen's timeline does not.
    const staff = (await view(first, id)).timeline;
    expect(staff.find((e: any) => e.kind === 'declined')).toMatchObject({ label: 'Declined: Busy on another incident' });
    expect(staff.find((e: any) => e.kind === 'accept').by).toBeTruthy();
    expect((await view('citizen', id)).timeline.every((e: any) => e.by === undefined)).toBe(true);

    // Drone request and reinforcement reach the station head.
    await http.post(`/incidents/${id}/events`).set(as(first)).send({ kind: 'drone_requested' }).expect(201);
    const n = (await http.get('/me/notifications').set(as('head'))).body.items.find((x: any) => x.type === 'drone_requested');
    expect(n.body).toMatch(/asks for a drone at Robbery, AB12C\.$/);
  });
});
