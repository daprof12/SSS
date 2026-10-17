-- Phone OTP sign-in (C6: phone first), refresh sessions and onboarding progress.

-- One row per code sent. Only a hash is stored; the code itself goes by SMS.
create table otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null check (phone ~ '^\+234\d{10}$'),
  purpose      text not null default 'sign_in' check (purpose in ('sign_in', 'step_up', 'change_phone')),
  code_hash    text not null,
  attempts     smallint not null default 0,
  max_attempts smallint not null default 5,          -- C3: 5 tries
  expires_at   timestamptz not null,                 -- C3: 5 minutes
  consumed_at  timestamptz,
  ip           inet,
  created_at   timestamptz not null default now()
);
create index on otp_challenges (phone, created_at desc);

-- Refresh token (opaque, hashed) lives on the session; the access JWT carries the session id.
alter table sessions
  add column refresh_hash text unique,
  add column label        text,
  add column platform     text;

alter table users
  add column onboarding jsonb not null default '{}',   -- {"tour": "2026-10-17T…", "permissions": …}
  add column onboarded_at timestamptz;
