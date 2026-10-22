// What each agency handles, bounty rates, and funding the bounty pool.
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
let seed: { users: Record<string, string>; agencyId: string; naptipId: string; fermaId: string };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let n = 0;
const key = () => `pool-${Date.now()}-${++n}`;

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

const adminOf = (agencyId: string) => (agencyId === seed.agencyId ? 'agencyAdmin' : agencyId === seed.fermaId ? 'fermaAdmin' : 'naptipAdmin');
const summary = (agencyId = seed.naptipId) => http.get(`/agencies/${agencyId}/bounties/summary`).set(as(adminOf(agencyId)));

describe('menus follow what the agency handles', () => {
  it('tells the dashboard which queues each agency has', async () => {
    // One agency per admin: nobody switches agency.
    const mine = async (who: string) => (await http.get('/me/agencies').set(as(who)).expect(200)).body;
    expect(await mine('agencyAdmin')).toEqual([expect.objectContaining({ id: seed.agencyId })]);
    const all = [...(await mine('agencyAdmin')), ...(await mine('naptipAdmin')), ...(await mine('fermaAdmin'))];
    const by = (id: string) => all.find((a: any) => a.id === id).handles;
    expect(by(seed.naptipId)).toEqual({ tips: true, bounties: true, issues: false });
    expect(by(seed.fermaId)).toEqual({ tips: false, bounties: false, issues: true });
    expect(by(seed.agencyId)).toEqual({ tips: true, bounties: true, issues: true }); // police: cult tips and one chance vehicles
  });

  it('refuses queues an agency does not handle', async () => {
    expect((await http.get(`/agencies/${seed.naptipId}/issues`).set(as('naptipAdmin')).expect(409)).body.message).toBe('Your agency does not handle public issues.');
    expect((await http.get(`/agencies/${seed.fermaId}/tips`).set(as('fermaAdmin')).expect(409)).body.message).toBe('Your agency does not receive tips.');
    await summary(seed.fermaId).expect(409);
  });
});

describe('bounty rates', () => {
  it('lists every bounty category the agency receives, with its rate', async () => {
    const s = (await summary().expect(200)).body;
    expect(s.rates).toEqual([
      expect.objectContaining({ category: 'human_trafficking', label: 'Human trafficking', verifiedWhen: 'Victim rescued or case opened', set: true, standardKobo: 5000000, seriousKobo: 50000000 }),
    ]);
  });

  it('validates and saves a rate, and only for its own categories', async () => {
    const put = (category: string, body: Record<string, unknown>) => http.put(`/agencies/${seed.naptipId}/bounty-rates/${category}`).set(as('naptipAdmin')).send(body);
    expect((await put('human_trafficking', { basis: 'tiered', standardKobo: 10000000, seriousKobo: 5000000 }).expect(422)).body.message).toBe('A serious result should pay at least the standard amount.');
    expect((await put('human_trafficking', { basis: 'tiered', standardKobo: 10000000, seriousKobo: 40000000, capKobo: 20000000 }).expect(422)).body.message).toBe('The cap must be at least the highest bounty.');
    await put('drugs', { basis: 'fixed', standardKobo: 10000000 }).expect(422);
    await put('human_trafficking', { basis: 'tiered', standardKobo: 10000000, seriousKobo: 40000000, capKobo: 60000000 }).expect(200);
    expect((await summary()).body.rates[0]).toMatchObject({ basis: 'tiered', standardKobo: 10000000, seriousKobo: 40000000, capKobo: 60000000, active: true });
    // Officers and citizens see the new range on the tip form.
    const cats = (await http.get('/tips/categories').set(as('citizen'))).body;
    expect(cats.find((c: any) => c.code === 'human_trafficking').bounty.text).toBe('₦100,000 to ₦400,000');
  });
});

describe('funding the bounty pool', () => {
  it('adds money to the pool only after Paystack confirms', async () => {
    const before = (await summary()).body.pool.availableKobo;
    const fund = (body: Record<string, unknown>) => http.post(`/agencies/${seed.naptipId}/bounty-pool/fund`).set(as('naptipAdmin')).send({ method: 'card', idempotencyKey: key(), ...body });
    expect((await fund({ amountKobo: 500000 }).expect(422)).body.message).toBe('Enter between ₦10,000.00 and ₦50,000,000.00.');

    const idem = key();
    const r = (await fund({ amountKobo: 100000000, idempotencyKey: idem }).expect(201)).body;
    expect(r).toMatchObject({ state: 'pending', checkoutUrl: expect.any(String) });
    expect((await fund({ amountKobo: 100000000, idempotencyKey: idem }).expect(201)).body).toMatchObject({ reference: r.reference, replayed: true });

    let s = (await summary()).body;
    expect(s.pool.availableKobo).toBe(before);
    expect(s.pendingFunding[0]).toMatchObject({ reference: r.reference, amountKobo: 100000000 });

    await http.post(`/dev/paystack/complete/${r.reference}`).expect(201);
    s = (await summary()).body;
    expect(s.pool.availableKobo).toBe(before + 100000000);
    expect(s.history[0]).toMatchObject({ kind: 'fund', amountKobo: 100000000, label: 'Pool funded by card' });
    expect(s.pendingFunding).toEqual([]);
    expect((await http.get(`/agencies/${seed.naptipId}/bounty-pool/payments/${r.reference}`).set(as('naptipAdmin'))).body.message).toBe('₦1,000,000.00 was added to your bounty pool.');
    const notes = (await http.get('/me/notifications').set(as('naptipAdmin'))).body.items;
    expect(notes.find((x: any) => x.type === 'pool_funded').body).toBe('₦1,000,000.00 was added to your bounty pool.');
  });

  it('tells the agency when funding fails and leaves the pool alone', async () => {
    const before = (await summary()).body.pool.availableKobo;
    const r = (await http.post(`/agencies/${seed.naptipId}/bounty-pool/fund`).set(as('naptipAdmin')).send({ amountKobo: 2000000, method: 'card', idempotencyKey: key() }).expect(201)).body;
    await http.post(`/dev/paystack/complete/${r.reference}?outcome=failed`).expect(201);
    expect((await summary()).body.pool.availableKobo).toBe(before);
    expect((await http.get('/me/notifications').set(as('naptipAdmin'))).body.items.some((x: any) => x.type === 'pool_fund_failed')).toBe(true);
  });

  it('shows paid bounties and warns when claims are above the pool', async () => {
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'Girls are kept in a house on Allen and moved at night by a white bus.', clientRef: key(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    const act = (body: Record<string, unknown>) => http.post(`/agencies/${seed.naptipId}/tips/${tip.id}/actions`).set(as('naptipAdmin')).send(body).expect(201);
    await act({ event: 'outcome_recorded', outcome: 'rescue', severity: 'high' });
    let s = (await summary()).body;
    expect(s.claimsWaiting).toBe(1);
    expect(s.pool.pendingClaimsKobo).toBe(44000000); // ₦400,000 bounty + 10% platform fee
    expect(s.pool.low).toBeNull();
    await act({ event: 'approve' });
    s = (await summary()).body;
    expect(s.paidThisMonth).toEqual({ kobo: 40000000, tips: 1 });
    expect(s.history.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'fee', amountKobo: -4000000, label: `Platform fee, tip ${tip.publicNo}` }),
      expect.objectContaining({ kind: 'paid', amountKobo: -40000000, label: `Bounty for tip ${tip.publicNo}` }),
    ]);
    expect(s.tipsThisMonth).toBeGreaterThanOrEqual(1);
  });
});

describe('percentage-of-value rates', () => {
  it('pays a share of what was recovered, up to the cap', async () => {
    const put = (body: Record<string, unknown>) => http.put(`/agencies/${seed.naptipId}/bounty-rates/human_trafficking`).set(as('naptipAdmin')).send(body);
    expect((await put({ basis: 'percent_capped', percent: 5 }).expect(422)).body.message).toBe('A share of the value needs a cap per tip.');
    await put({ basis: 'percent_capped', percent: 5, capKobo: 100_000_000 }).expect(200);
    expect((await summary()).body.rates[0]).toMatchObject({ basis: 'percent_capped', percent: 5, capKobo: 100_000_000 });
    const cats = (await http.get('/tips/categories').set(as('citizen'))).body;
    expect(cats.find((c: any) => c.code === 'human_trafficking').bounty.text).toBe('5% of the value recovered, up to ₦1,000,000');

    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'A bus moves people across the border at night from the motor park.', clientRef: key(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    const act = (body: Record<string, unknown>) => http.post(`/agencies/${seed.naptipId}/tips/${tip.id}/actions`).set(as('naptipAdmin')).send(body);
    expect((await act({ event: 'outcome_recorded', outcome: 'seizure' }).expect(422)).body.message).toBe('Enter the value recovered or seized. This rate pays a share of it.');
    await act({ event: 'outcome_recorded', outcome: 'seizure', recoveredKobo: 400_000_000 }).expect(201);
    const d = (await http.get(`/agencies/${seed.naptipId}/tips/${tip.id}`).set(as('naptipAdmin'))).body;
    expect(d.claim).toMatchObject({ suggestedKobo: 20_000_000, recoveredKobo: 400_000_000 });
    await act({ event: 'decline', reason: 'Seizure was by another unit.' }).expect(201);
  });
});

describe('paying the pool back when an agency leaves', () => {
  it('waits for claims, closes the pool, and pays it out through an approved transfer', async () => {
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'human_trafficking', description: 'Children are made to beg at the junction every morning by two men.', clientRef: key(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    await http.post(`/agencies/${seed.naptipId}/tips/${tip.id}/actions`).set(as('naptipAdmin')).send({ event: 'outcome_recorded', outcome: 'rescue', recoveredKobo: 10_000_000 }).expect(201);
    const leave = () => http.post(`/agencies/${seed.naptipId}/offboard`).set(as('naptipAdmin')).send({ reason: 'Moving to the federal system' });
    expect((await leave().expect(422)).body.message).toBe('Decide the bounty claim waiting before you leave.');
    await http.post(`/agencies/${seed.naptipId}/tips/${tip.id}/actions`).set(as('naptipAdmin')).send({ event: 'approve' }).expect(201);

    const pool = (await summary()).body.pool.availableKobo;
    const r = (await leave().expect(201)).body;
    const payoutId = r.blockers.find((b: any) => b.code === 'pending_payout').ref;
    let s = (await summary()).body;
    expect(s).toMatchObject({ closed: true, payout: { amountKobo: pool, state: 'pending', line: 'Waiting for our team to approve.' } });
    expect((await http.post(`/agencies/${seed.naptipId}/bounty-pool/fund`).set(as('naptipAdmin')).send({ amountKobo: 2_000_000, method: 'card', idempotencyKey: key() }).expect(409)).body.message).toBe(
      'Your agency is leaving, so the bounty pool is closed and is being paid back to you.',
    );

    // Verified account and a second platform approver (the payout is above the threshold).
    await db.query(`insert into bank_accounts (owner_type, owner_id, bank_code, bank_name, last_four, account_name, name_match, verified_at) values ('agency', $1, '058', 'GTBank', '4321', 'NAPTIP', true, now())`, [seed.naptipId]);
    const admin2 = (await db.query(`insert into users (phone, display_name) values ('+2348039990001', 'Second Admin') returning id`)).rows[0].id;
    await db.query(`insert into user_roles (user_id, role, scope_type) values ($1, 'platform_admin', 'platform')`, [admin2]);
    t.admin2 = (await http.post('/dev/token').send({ userId: admin2 }).expect(201)).body.token;

    expect((await http.post(`/admin/payouts/${payoutId}/approve`).set(as('platformAdmin')).expect(201)).body.state).toBe('awaiting_second_approval');
    expect((await http.post(`/admin/payouts/${payoutId}/approve`).set(as('admin2')).expect(201)).body.state).toBe('processing');
    s = (await summary()).body;
    expect(s.pool.availableKobo).toBe(0);
    expect(s.payout.line).toBe('On its way to your bank.');

    // The bank refuses it: the money goes back to the pool and the agency is told.
    await http.post(`/dev/paystack/transfer/${payoutId}?outcome=failed`).expect(201);
    s = (await summary()).body;
    expect(s.pool.availableKobo).toBe(pool);
    expect(s.payout.state).toBe('failed');
    const blockers = (await http.get(`/agencies/${seed.naptipId}/offboard`).set(as('naptipAdmin'))).body.blockers;
    expect(blockers[0]).toMatchObject({ code: 'payout_failed' });
    expect((await http.get('/me/notifications').set(as('naptipAdmin'))).body.items.some((x: any) => x.type === 'payout_failed')).toBe(true);

    // Sent again, and this time it lands.
    expect((await http.post(`/admin/payouts/${payoutId}/retry`).set(as('platformAdmin')).expect(201)).body.state).toBe('processing');
    await http.post(`/dev/paystack/transfer/${payoutId}`).expect(201);
    s = (await summary()).body;
    expect(s.pool.availableKobo).toBe(0);
    expect(s.payout).toMatchObject({ state: 'paid', line: 'Sent to your bank.' });
    const queue = (await http.get('/admin/payouts?state=paid').set(as('platformAdmin')).expect(200)).body;
    expect(queue.find((x: any) => x.id === payoutId)).toMatchObject({ agency: 'NAPTIP (demo)', amountKobo: pool, approvals: 2 });
    expect((await http.get(`/agencies/${seed.naptipId}/offboard`).set(as('naptipAdmin'))).body.canComplete).toBe(true);
  });
});

describe('payout queue for platform admins', () => {
  it('shows gross, fee, net and destination, and holds only with a note', async () => {
    await db.query(`insert into bank_accounts (owner_type, owner_id, bank_code, bank_name, last_four, account_name, name_match, verified_at) values ('agency', $1, '011', 'First Bank', '9876', 'Nigeria Police Force', true, now())`, [seed.agencyId]);
    const id = (await db.query(`insert into payouts (agency_id, amount_kobo, reason) values ($1, 5000000, 'Test payout') returning id`, [seed.agencyId])).rows[0].id;
    await http.get('/admin/payouts').set(as('agencyAdmin')).expect(403);

    const row = (await http.get('/admin/payouts?state=pending').set(as('platformAdmin')).expect(200)).body.find((x: any) => x.id === id);
    expect(row).toMatchObject({
      agency: 'Nigeria Police Force (demo)',
      amountKobo: 5_000_000,
      feeKobo: 2_500,
      netKobo: 4_997_500,
      approvalsNeeded: 1,
      approvedByMe: false,
      destination: { bank: 'First Bank', lastFour: '9876', verified: true },
    });

    expect((await http.post(`/admin/payouts/${id}/hold`).set(as('platformAdmin')).send({ note: '' }).expect(400)).body.fields[0].message).toBe('Say why you are holding it.');
    await http.post(`/admin/payouts/${id}/hold`).set(as('platformAdmin')).send({ note: 'Checking a dispute on tip T-1' }).expect(201);
    await http.post(`/admin/payouts/${id}/approve`).set(as('platformAdmin')).expect(409);
    expect((await http.get('/admin/payouts?state=held').set(as('platformAdmin'))).body[0]).toMatchObject({ id, holdNote: 'Checking a dispute on tip T-1' });
    await http.post(`/admin/payouts/${id}/release`).set(as('platformAdmin')).expect(201);
    expect((await http.post(`/admin/payouts/${id}/approve`).set(as('platformAdmin')).expect(201)).body.state).toBe('processing');
  });
});

describe('platform fee on bounties', () => {
  const feeWallet = async () => Number((await db.query(`select coalesce(sum(l.amount_kobo), 0)::bigint as k from wallet_ledger l join wallets w on w.id = l.wallet_id where w.owner_type = 'platform_fees'`)).rows[0].k);

  it('lets platform admins set the suggestion and range, with checks', async () => {
    await http.get('/admin/settings/bounty-fee').set(as('agencyAdmin')).expect(403);
    const s = (await http.get('/admin/settings/bounty-fee').set(as('platformAdmin')).expect(200)).body;
    expect(s).toMatchObject({ suggestedBps: 1000, minBps: 500, maxBps: 2000 });
    expect((await http.put('/admin/settings/bounty-fee').set(as('platformAdmin')).send({ suggestedBps: 3000, minBps: 500, maxBps: 2000 }).expect(422)).body.message).toBe(
      'The suggested fee must be inside the range.',
    );
    expect((await http.put('/admin/settings/bounty-fee').set(as('platformAdmin')).send({ suggestedBps: 800, minBps: 500, maxBps: 1500 }).expect(200)).body.message).toBe(
      'Suggested fee 8%; agencies can choose 5% to 15%.',
    );
    expect((await summary(seed.agencyId)).body.fee).toMatchObject({ bps: 800, label: '8%', chosenBps: null });
  });

  it('lets an agency choose its fee within the range, and charges it on top of the bounty', async () => {
    const set = (bps: number | null) => http.put(`/agencies/${seed.agencyId}/bounty-fee`).set(as('agencyAdmin')).send({ bps });
    expect((await set(2500).expect(422)).body.message).toBe('Choose between 5% and 15%.');
    expect((await set(1200).expect(200)).body.message).toBe('Platform fee set to 12% of each bounty.');

    // Police: rate and pool for cult activity, then a claim approved at ₦100,000.
    await http.put(`/agencies/${seed.agencyId}/bounty-rates/cult_activity`).set(as('agencyAdmin')).send({ basis: 'fixed', standardKobo: 10_000_000 }).expect(200);
    const f = (await http.post(`/agencies/${seed.agencyId}/bounty-pool/fund`).set(as('agencyAdmin')).send({ amountKobo: 50_000_000, method: 'card', idempotencyKey: key() }).expect(201)).body;
    await http.post(`/dev/paystack/complete/${f.reference}`).expect(201);
    const tip = (
      await http
        .post('/tips')
        .set(as('citizen'))
        .send({ category: 'cult_activity', description: 'Young men initiate members at the abandoned school every Friday night.', clientRef: key(), postcode: 'CD34E' })
        .expect(201)
    ).body;
    const act = (body: Record<string, unknown>) => http.post(`/agencies/${seed.agencyId}/tips/${tip.id}/actions`).set(as('agencyAdmin')).send(body).expect(201);
    await act({ event: 'outcome_recorded', outcome: 'arrest' });
    const before = { pool: (await summary(seed.agencyId)).body.pool.availableKobo, fees: await feeWallet() };
    await act({ event: 'approve' });

    const after = (await summary(seed.agencyId)).body;
    expect(after.pool.availableKobo).toBe(before.pool - 10_000_000 - 1_200_000);
    expect(await feeWallet()).toBe(before.fees + 1_200_000);
    const d = (await http.get(`/agencies/${seed.agencyId}/tips/${tip.id}`).set(as('agencyAdmin'))).body;
    expect(d.claim).toMatchObject({ approvedKobo: 10_000_000, feeKobo: 1_200_000 });
    // The tipper is told the full bounty.
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'bounty_approved');
    expect(note.body).toMatch(/^₦100,000\.00 was added to your wallet/);

    // Back to the suggestion; and a narrower range applies to agencies that chose outside it.
    expect((await set(null).expect(200)).body.message).toBe('Using the suggested fee of 8%.');
    await set(1500).expect(200);
    await http.put('/admin/settings/bounty-fee').set(as('platformAdmin')).send({ suggestedBps: 800, minBps: 500, maxBps: 1000 }).expect(200);
    expect((await summary(seed.agencyId)).body.fee).toMatchObject({ bps: 1000, chosenBps: 1500 });
    expect((await http.get('/admin/settings/bounty-fee').set(as('platformAdmin'))).body.agencies).toEqual([expect.objectContaining({ name: 'Nigeria Police Force (demo)', chosenBps: 1500, bps: 1000, outside: true })]);
  });
});
