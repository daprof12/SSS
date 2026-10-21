// Rewards for rated responses: the agency's amount and split, held days, caps and anti-gaming.
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
let agencyId: string;
let stationId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ref = () => `rw-${Date.now()}-${++n}`;
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
const rewardsOf = async (who: string) =>
  Number((await db.query(`select coalesce(sum(l.amount_kobo), 0)::bigint as k from wallet_ledger l join wallets w on w.id = l.wallet_id where w.owner_type = 'user' and w.owner_id = $1 and l.type = 'reward'`, [users[who]])).rows[0].k);

/** A robbery the reporter rates once it is closed. With `support`, the other officer joins as reinforcement. */
async function respond(reporter: string, stars: number, support = false) {
  const id = (await http.post('/incidents').set(as(reporter)).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
  await waitFor(() => view(reporter, id), (x) => x.state === 'offered');
  let lead = '';
  for (const w of ['officer', 'officer2']) if ((await view(w, id)).view === 'officer') lead = w;
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'accept' }).expect(201);
  const other = lead === 'officer' ? 'officer2' : 'officer';
  if (support) {
    await db.query(`insert into incident_units (incident_id, station_id, officer_id, role, state, accepted_at) values ($1, $2, $3, 'reinforcement', 'on_scene', now())`, [id, stationId, users[other]]);
  }
  for (const event of ['start_route', 'arrive', 'begin_close']) await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event }).expect(201);
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'close_valid', outcomeCode: 'arrest' }).expect(201);
  if (support) await db.query(`update incident_units set state = 'released' where incident_id = $1`, [id]);
  await http.post(`/incidents/${id}/rating`).set(as(reporter)).send({ stars }).expect(201);
  const decision = (await db.query(`select * from reward_payments where incident_id = $1`, [id])).rows[0];
  return { id, lead, other, decision };
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  agencyId = seed.agencyId;
  stationId = seed.stationId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [stationId, u, lng, lat]);
  }
});
afterAll(async () => {
  await app?.close();
});

describe('rewards for ratings', () => {
  it('pays the agency’s amount for 5 stars, held 7 days, and tells the officer', async () => {
    const r = await respond('citizen', 5);
    expect(r.decision).toMatchObject({ state: 'paid', total_kobo: 500000 });
    expect(await rewardsOf(r.lead)).toBe(500_000);
    const w = (await http.get('/me/wallet').set(as(r.lead))).body;
    expect(w.heldKobo).toBe(500_000); // not withdrawable until the hold ends
    const note = (await http.get('/me/notifications').set(as(r.lead))).body.items.find((x: any) => x.type === 'reward_earned');
    expect(note.body).toMatch(/^You earned ₦5,000\.00 for a 5-star response\. It is released on \d+ \w+\.$/);
    const d = (await http.get(`/me/officer/history/${r.id}`).set(as(r.lead))).body;
    expect(d.team[0]).toMatchObject({ you: true, rewardKobo: 500_000 });
    expect(d.rewardNote).toMatch(/^Reward ₦5,000\.00 split by the Station 4 Ikeja rule\. Paid to wallets on /);
  });

  it('pays half for 4 stars and nothing for 3', async () => {
    expect((await respond('citizen', 4)).decision).toMatchObject({ state: 'paid', total_kobo: 250000 });
    expect((await respond('citizen', 3)).decision).toMatchObject({ state: 'skipped', reason: 'low_rating' });
  });

  it('splits a team response by the agency rule, the lead first', async () => {
    const r = await respond('neighbour', 5, true);
    expect(r.decision.state).toBe('paid');
    const shares = Object.fromEntries((r.decision.shares as { id: string; kobo: number }[]).map((s) => [s.id, s.kobo]));
    expect(shares[users[r.lead]!]).toBe(250_000);
    expect(shares[users[r.other]!]).toBe(250_000);
    // A joiner rating the same incident does not pay again.
    await http.post(`/incidents/${r.id}/rating`).set(as('neighbour')).send({ stars: 5 }).expect(409);
    expect((await db.query(`select count(*)::int as n from reward_payments where incident_id = $1`, [r.id])).rows[0].n).toBe(1);
  });

  it('stops paying for a reporter who keeps rating the same station (rating rings)', async () => {
    expect((await respond('citizen', 5)).decision).toMatchObject({ state: 'skipped', reason: 'repeat_rater' });
  });

  it('lets the agency set, check and pause its rule, and shows what was paid', async () => {
    const put = (body: Record<string, unknown>) => http.put(`/agencies/${agencyId}/reward-rule`).set(as('agencyAdmin')).send(body);
    expect((await put({ fiveStarKobo: 9_000_000, fourStarPct: 50, split: 'equal', active: true }).expect(422)).body.message).toBe('Enter up to ₦25,000.00 for a 5-star response.');
    expect((await put({ fiveStarKobo: 800_000, fourStarPct: 25, split: 'equal', active: true }).expect(200)).body.message).toBe('Rewards on: ₦8,000.00 for a 5-star response.');
    const s = (await http.get(`/agencies/${agencyId}/rewards`).set(as('agencyAdmin')).expect(200)).body;
    expect(s.rule).toMatchObject({ fiveStarKobo: 800_000, fourStarPct: 25, split: 'equal', active: true });
    expect(s.month).toMatchObject({ kobo: 1_250_000, paid: 3, skipped: 2 });
    expect(s.recent.find((x: any) => x.reason === 'Same person rated this station too often')).toBeTruthy();
    expect((await http.put(`/agencies/${agencyId}/donation-shares`).set(as('agencyAdmin')).send({ officerPct: 50, stationPct: 30, agencyPct: 30 }).expect(422)).body.message).toBe('The three shares must add up to 100%.');
    await http.put(`/agencies/${agencyId}/donation-shares`).set(as('agencyAdmin')).send({ officerPct: 50, stationPct: 30, agencyPct: 20 }).expect(200);

    await put({ fiveStarKobo: 800_000, fourStarPct: 25, split: 'equal', active: false }).expect(200);
    expect((await respond('neighbour', 5)).decision).toMatchObject({ state: 'skipped', reason: 'no_rule' });
    await http.get(`/agencies/${agencyId}/rewards`).set(as('citizen')).expect(404);
  });
});
