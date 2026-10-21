-- Citizen profile and home: security, fines and appeals (B8), donations and receipts (B9),
-- help, household invites (B4 step 8), devices and repairs (B5, B6).

-- Security: face or fingerprint stays on the phone; we keep only the person's choices.
alter table users
  add column biometrics         boolean not null default false,
  add column biometric_open_app boolean not null default true,
  add column biometric_signing  boolean not null default true;

alter table otp_challenges drop constraint otp_challenges_purpose_check;
alter table otp_challenges add constraint otp_challenges_purpose_check check (purpose in ('sign_in', 'step_up', 'change_phone', 'pin_reset', 'mfa_setup'));

-- Fines: warnings first (records, not fines), then a fine.
create table false_alarm_warnings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  incident_id uuid not null references incidents(id),
  created_at  timestamptz not null default now(),
  unique (user_id, incident_id)
);
alter table fines
  add column number       text unique,
  add column reason       text not null default 'No incident found on arrival',
  add column trust_delta  smallint not null default 0,
  add column due_kobo     bigint,
  add column appeal_note  text,
  add column appealed_at  timestamptz,
  add column decided_at   timestamptz,
  add column paid_at      timestamptz,
  add column payment_id   uuid references payments(id);
create unique index fines_user_incident on fines (user_id, incident_id);

-- Donations and receipts.
alter table donations
  add column state   text not null default 'pending' check (state in ('pending', 'paid', 'failed')),
  add column method  text check (method in ('wallet', 'card', 'bank_transfer', 'ussd')),
  add column shares  jsonb not null default '[]',
  add column paid_at timestamptz;
alter table payments add column receipt_no text unique;

-- Help and support.
create table support_tickets (
  id         uuid primary key default gen_random_uuid(),
  number     text not null unique,
  user_id    uuid not null references users(id),
  topic      text not null check (topic in ('app', 'money', 'report', 'device', 'account', 'other')),
  body       text not null check (char_length(body) between 10 and 2000),
  related_id uuid,
  state      text not null default 'open' check (state in ('open', 'answered', 'closed')),
  reply      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger support_tickets_updated before update on support_tickets for each row execute function set_updated_at();

-- Household: what each member may do, and invites by phone.
alter table property_members
  add column can_get_alerts boolean not null default true,
  add column can_report     boolean not null default false;
create table property_invites (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references properties(id),
  phone          text not null,
  invitee_id     uuid references users(id),
  can_view_live  boolean not null default true,
  can_get_alerts boolean not null default true,
  can_report     boolean not null default false,
  state          text not null default 'sent' check (state in ('sent', 'active', 'declined', 'revoked')),
  invited_by     uuid not null references users(id),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);
create unique index property_invites_open on property_invites (property_id, phone) where state = 'sent';

-- Devices: a name the owner sees, battery, settings, motion and the owner's street-light boost.
alter table devices
  add column name           text,
  add column battery_pct    smallint check (battery_pct between 0 and 100),
  add column settings       jsonb not null default '{"recordingDays": 7, "shareWithResponders": "emergency_only"}',
  add column last_motion_at timestamptz,
  add column lit_hours      numeric(4, 1),
  add column boost_until    timestamptz;

-- Repairs reuse install_jobs (kind 'repair'); the status page is derived from these timestamps.
alter table install_jobs
  add column number             text unique,
  add column device_id          uuid references devices(id),
  add column problem            text,
  add column description        text,
  add column best_time          text,
  add column urgent             boolean not null default false,
  add column reported_by        uuid references users(id),
  add column covered            boolean not null default true,
  add column visit_window       text,
  add column fault_confirmed_at timestamptz,
  add column booked_at          timestamptz,
  add column fixed_at           timestamptz,
  add column confirmed_at       timestamptz;

alter table media drop constraint media_owner_type_check;
alter table media add constraint media_owner_type_check check (owner_type in ('tip', 'issue_case', 'incident', 'learn_post', 'field_report', 'fine', 'repair'));
