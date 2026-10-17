-- Extensions, shared helpers and the hash-chained audit log.
create extension if not exists postgis;
create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Append-only guard for logs and ledgers (Backend Schema: "revoke update, delete").
-- Enforced by trigger so it also binds the table owner, not only the app role.
create or replace function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end $$;

create table audit_log (
  id          bigserial primary key,
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  reason      text,
  ip          inet,
  payload     jsonb not null default '{}',
  at          timestamptz not null default clock_timestamp(),
  prev_hash   bytea,
  hash        bytea not null
);
create index on audit_log (entity, entity_id);
create index on audit_log (actor_id, at desc);

-- Each row's hash covers its content and the previous row's hash, so any edit
-- or deletion in the middle breaks the chain (Security doc: tamper-evident).
create or replace function audit_chain() returns trigger language plpgsql as $$
declare
  last_hash bytea;
begin
  perform pg_advisory_xact_lock(hashtext('audit_log_chain'));
  select hash into last_hash from audit_log order by id desc limit 1;
  new.prev_hash := last_hash;
  new.hash := digest(
    coalesce(encode(last_hash, 'hex'), '') || '|' ||
    jsonb_build_object(
      'actor_id', new.actor_id, 'actor_role', new.actor_role, 'action', new.action,
      'entity', new.entity, 'entity_id', new.entity_id, 'reason', new.reason, 'ip', host(new.ip),
      'payload', new.payload, 'at', to_char(new.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::text,
    'sha256');
  return new;
end $$;

create trigger audit_log_chain before insert on audit_log for each row execute function audit_chain();
create trigger audit_log_immutable before update or delete on audit_log for each row execute function forbid_change();

-- Returns the id of the first broken row, or null when the chain is intact.
create or replace function audit_verify() returns bigint language plpgsql as $$
declare
  r record;
  expected bytea;
  prev bytea := null;
begin
  for r in select * from audit_log order by id loop
    expected := digest(
      coalesce(encode(prev, 'hex'), '') || '|' ||
      jsonb_build_object(
        'actor_id', r.actor_id, 'actor_role', r.actor_role, 'action', r.action,
        'entity', r.entity, 'entity_id', r.entity_id, 'reason', r.reason, 'ip', host(r.ip),
        'payload', r.payload, 'at', to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )::text,
      'sha256');
    if r.hash is distinct from expected or r.prev_hash is distinct from prev then
      return r.id;
    end if;
    prev := r.hash;
  end loop;
  return null;
end $$;
