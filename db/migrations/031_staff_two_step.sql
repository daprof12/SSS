-- Staff two-step login: phone code first, then a code from an authenticator app (TOTP, RFC 6238).
-- The app's secret is stored encrypted; recovery codes are stored hashed and work once each.
create table staff_totp (
  user_id      uuid primary key references users(id),
  secret_enc   text not null,
  confirmed_at timestamptz,
  last_step    bigint,               -- the last 30-second step used, so a code never works twice
  created_at   timestamptz not null default now()
);
-- Recovery codes use the existing recovery_codes table (migration 002).
alter table sessions add column mfa_failures smallint not null default 0;
