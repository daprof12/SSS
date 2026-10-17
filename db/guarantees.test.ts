// Checks the guarantees the database must enforce on its own, whatever the app does.
// Needs the local database: npm run db:up && npm run db:migrate
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://erp:erp_local_only@localhost:54329/erp' });
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

let userId: string;
let walletA: string;
let walletB: string;

beforeAll(async () => {
  userId = (await q(`insert into users (phone, display_name) values ($1, 'Test User') returning id`, [`+23480${Date.now() % 1e8}`])).rows[0].id;
  walletA = (await q(`insert into wallets (owner_type, owner_id) values ('user', $1) returning id`, [userId])).rows[0].id;
  walletB = (await q(`select id from wallets where owner_type = 'platform'`)).rows[0].id;
});

afterAll(() => pool.end());

describe('audit log', () => {
  it('chains hashes and verifies clean', async () => {
    await q(`insert into audit_log (actor_id, action, entity, entity_id, reason) values ($1, 'camera.view', 'device', 'cam-1', 'incident check')`, [userId]);
    await q(`insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'fine.waive', 'fine', 'f-1')`, [userId]);
    const rows = (await q(`select prev_hash, hash from audit_log order by id desc limit 2`)).rows;
    expect(rows[0].prev_hash.equals(rows[1].hash)).toBe(true);
    expect((await q(`select audit_verify() as broken`)).rows[0].broken).toBeNull();
  });

  it('refuses updates and deletes', async () => {
    await expect(q(`update audit_log set reason = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(q(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });

  it('detects tampering even by someone who bypasses the trigger', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const id = (await c.query(`select id from audit_log order by id limit 1`)).rows[0].id;
      await c.query(`alter table audit_log disable trigger audit_log_immutable`);
      await c.query(`update audit_log set reason = 'tampered' where id = $1`, [id]);
      const broken = (await c.query(`select audit_verify() as broken`)).rows[0].broken;
      expect(Number(broken)).toBe(Number(id));
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('wallet ledger', () => {
  it('accepts a balanced journal and derives the balance', async () => {
    const j = randomUUID();
    await inTx(async (c) => {
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', 500000, $3, $2)`, [walletA, j, `ref-${j}`]);
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', -500000, $3, $2)`, [walletB, j, `ref-${j}`]);
    });
    const bal = (await q(`select available_kobo from wallet_balances where wallet_id = $1`, [walletA])).rows[0];
    expect(Number(bal.available_kobo)).toBe(500000);
  });

  it('rejects a journal that does not balance', async () => {
    const j = randomUUID();
    await expect(
      inTx((c) => c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', 100, $3, $2)`, [walletA, j, `ref-${j}`])),
    ).rejects.toThrow(/does not balance/);
  });

  it('keeps held bounties out of the available balance', async () => {
    const j = randomUUID();
    await inTx(async (c) => {
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, available_at) values ($1, 'bounty', 20000, $3, $2, now() + interval '7 days')`, [walletA, j, `b-${j}`]);
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'bounty', -20000, $3, $2)`, [walletB, j, `b-${j}`]);
    });
    const bal = (await q(`select available_kobo, held_kobo from wallet_balances where wallet_id = $1`, [walletA])).rows[0];
    expect(Number(bal.available_kobo)).toBe(500000);
    expect(Number(bal.held_kobo)).toBe(20000);
  });

  it('cannot be edited', async () => {
    await expect(q(`update wallet_ledger set amount_kobo = 1`)).rejects.toThrow(/append-only/);
  });

  it('books a Paystack reference only once per wallet and type', async () => {
    const j = randomUUID();
    const ref = `dup-${j}`;
    await inTx(async (c) => {
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', 100, $3, $2)`, [walletA, j, ref]);
      await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', -100, $3, $2)`, [walletB, j, ref]);
    });
    await expect(
      inTx(async (c) => {
        const j2 = randomUUID();
        await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id) values ($1, 'fund', 100, $3, $2)`, [walletA, j2, ref]);
      }),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('product rules held by the schema', () => {
  it('limits emergency contacts to three', async () => {
    for (let i = 0; i < 3; i++) await q(`insert into emergency_contacts (user_id, name, phone) values ($1, 'C', $2)`, [userId, `+2348100000${i}`]);
    await expect(q(`insert into emergency_contacts (user_id, name, phone) values ($1, 'C', '+23481000009')`, [userId])).rejects.toThrow(/at most 3/);
  });

  it('never lets safety or money notifications be switched off', async () => {
    await expect(q(`insert into notification_prefs values ($1, 'safety', 'push', false)`, [userId])).rejects.toThrow(/check constraint/);
    await expect(q(`insert into notification_prefs values ($1, 'money', 'sms', false)`, [userId])).rejects.toThrow(/check constraint/);
    await q(`insert into notification_prefs values ($1, 'marketing', 'push', false)`, [userId]);
  });

  it('requires an outcome code to resolve an incident and a target to merge', async () => {
    const insert = (state: string, extra = '') =>
      q(`insert into incidents (reporter_id, type, geom, state${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, 'fire', 'POINT(3.35 6.6)', $2${extra ? ', ' + extra.split('=')[1] : ''})`, [userId, state]);
    await expect(insert('resolved')).rejects.toThrow(/check constraint/);
    await expect(insert('merged')).rejects.toThrow(/check constraint/);
    await insert('resolved', "outcome_code='arrest'");
    await expect(insert('teleported')).rejects.toThrow(/check constraint/);
  });

  it('makes the response log append-only', async () => {
    const inc = (await q(`insert into incidents (reporter_id, type, geom) values ($1, 'medical', 'POINT(3.35 6.6)') returning id`, [userId])).rows[0].id;
    await q(`insert into incident_events (incident_id, actor_kind, kind) values ($1, 'system', 'window_elapsed')`, [inc]);
    await expect(q(`delete from incident_events where incident_id = $1`, [inc])).rejects.toThrow(/append-only/);
  });

  it('cannot start a subscription period before install', async () => {
    await q(`insert into plans (code, audience, name, price_kobo, interval) values ('household_test', 'household', 'Household', 500000, 'month') on conflict do nothing`);
    await expect(q(`insert into subscriptions (owner_id, plan_code, state) values ($1, 'household_test', 'active')`, [userId])).rejects.toThrow(/check constraint/);
    await q(`insert into subscriptions (owner_id, plan_code, state) values ($1, 'household_test', 'install_booked')`, [userId]);
  });

  it('stores masked ID only and requires a reason for every camera view', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_name = 'kyc_verifications'`)).rows.map((r) => r.column_name);
    expect(cols).toContain('id_masked');
    expect(cols.some((c: string) => /^(nin|bvn|id_number)$/.test(c))).toBe(false);
    await expect(q(`insert into camera_access_log (device_id, actor_id, actor_role, reason) values (gen_random_uuid(), $1, 'platform_admin', '')`, [userId])).rejects.toThrow(/check constraint/);
  });
});
