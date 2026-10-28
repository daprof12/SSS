// Tests get their own database (erp_test by default), so a run never wipes the development data or
// races the development server's background work (offer sweep, push delivery) on the same rows.
import pg from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp_local_only@localhost:54329/erp_test';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected test database name: ${name}`);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(TEST_DATABASE_URL), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const exists = (await admin.query(`select 1 from pg_database where datname = $1`, [name])).rowCount;
  if (!exists) await admin.query(`create database ${name}`);
  await admin.end();
}
