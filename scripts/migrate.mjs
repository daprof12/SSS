// Applies db/migrations/*.sql in order, each in its own transaction.
// --reset drops and recreates the public schema first (local databases only).
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://erp:erp_local_only@localhost:54329/erp';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const reset = process.argv.includes('--reset');

const client = new pg.Client({ connectionString: url });
await client.connect();

if (reset) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', 'db'].includes(host)) {
    console.error(`Refusing to reset a non-local database (${host}).`);
    process.exit(1);
  }
  await client.query('drop schema public cascade; create schema public;');
  console.log('schema reset');
}

await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  try {
    await client.query('begin');
    await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('insert into schema_migrations (name) values ($1)', [file]);
    await client.query('commit');
    console.log(`applied ${file}`);
  } catch (err) {
    await client.query('rollback');
    console.error(`failed ${file}: ${err.message}`);
    process.exitCode = 1;
    break;
  }
}
await client.end();
