// Surviving a restart: cancel windows and offers are timed in the API process; when it stops, the
// next one (or another server) finishes whatever came due, from the database.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { IncidentsService } from '../src/incidents/incidents.service';
import { createApp } from '../src/main';

let app: INestApplication | null = null;
let users: Record<string, string>;
let stationId: string;
const t: Record<string, string> = {};
let n = 0;
const ref = () => `restart-${Date.now()}-${++n}`;

/** Starts an API instance. A long cancel window keeps its own timer from firing during the test. */
async function start(cancelWindowMs = 60_000) {
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: String(cancelWindowMs) }));
  await app.listen(0);
  return { http: request(app.getHttpServer()), db: app.get(Db), incidents: app.get(IncidentsService) };
}
/** Stops it: its in-memory timers go with it, as in a crash or a deploy. */
async function stop() {
  await app?.close();
  app = null;
}
const state = async (db: Db, id: string) => (await db.query(`select state from incidents where id = $1`, [id])).rows[0].state;
const offered = async (db: Db, id: string) => (await db.query(`select officer_id from incident_units where incident_id = $1 and state = 'offered'`, [id])).rows.map((r) => r.officer_id);

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  const { http, db } = await start();
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [stationId, u, lng, lat]);
  }
  await stop();
});
afterAll(stop);

describe('after a restart', () => {
  it('sends on a report whose cancel window passed while the server was down', async () => {
    let s = await start();
    const id = (await s.http.post('/incidents').set({ Authorization: `Bearer ${t.citizen}` }).send({ type: 'robbery', postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
    expect(await state(s.db, id)).toBe('pending_cancel');
    await stop();

    // The window ran out while nothing was running.
    s = await start();
    await s.db.query(`update incidents set created_at = now() - interval '2 minutes' where id = $1`, [id]);
    const done = await s.incidents.sweepOverdue();
    expect(done.windows).toBe(1);
    expect(await state(s.db, id)).toBe('offered');
    expect(await offered(s.db, id)).toEqual([users.officer]);
    // Nothing left to do: a second sweep (or a second server) changes nothing.
    expect(await s.incidents.sweepOverdue()).toEqual({ windows: 0, offers: 0, routed: 0 });
    await stop();
  });

  it('moves an unanswered offer to the next officer, and the first one is recorded as missed', async () => {
    let s = await start();
    const id = (await s.db.query(`select i.id from incidents i join incident_units u on u.incident_id = i.id and u.state = 'offered' limit 1`)).rows[0].id;
    await stop();

    s = await start();
    await s.db.query(`update incident_units set offer_expires_at = now() - interval '1 minute' where incident_id = $1 and state = 'offered'`, [id]);
    expect((await s.incidents.sweepOverdue()).offers).toBe(1);
    expect(await offered(s.db, id)).toEqual([users.officer2]);
    expect((await s.db.query(`select state from incident_units where incident_id = $1 and officer_id = $2`, [id, users.officer])).rows[0].state).toBe('expired');
    expect(await state(s.db, id)).toBe('offered');
    await stop();
  });

  it('routes a report whose routing never ran, and leaves alone one where nobody was free', async () => {
    const s = await start();
    // Server stopped right after "Report received", before routing.
    const stranded = (await s.db.query(`select id from incidents where state = 'offered' limit 1`)).rows[0].id;
    await s.db.query(`update incident_units set state = 'released' where incident_id = $1`, [stranded]);
    await s.db.query(`update incidents set state = 'received' where id = $1`, [stranded]);
    await s.db.query(`insert into incident_events (incident_id, actor_kind, kind, payload, at) values ($1, 'system', 'window_elapsed', '{}', now() - interval '1 minute')`, [stranded]);
    expect((await s.incidents.sweepOverdue()).routed).toBe(1);
    expect(await state(s.db, stranded)).toBe('offered');

    // Nobody free: routing already told the station; the sweep does not keep re-trying it.
    await s.db.query(`update incident_units set state = 'released' where incident_id = $1`, [stranded]);
    await s.db.query(`update officers set on_duty = false`);
    await s.db.query(`update incidents set state = 'received' where id = $1`, [stranded]);
    await s.db.query(`insert into incident_events (incident_id, actor_kind, kind, payload, at) values ($1, 'system', 'no_responder', '{}', now() - interval '1 minute')`, [stranded]);
    expect((await s.incidents.sweepOverdue()).routed).toBe(0);
    await stop();
  });
});
