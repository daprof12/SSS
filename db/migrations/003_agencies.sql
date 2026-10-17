-- Agencies, stations, officers, technicians, invites and routing.
create table agencies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null,                      -- police, fire, health, efcc, ndlea, ...
  reg_no      text,
  location_id uuid references locations(id),
  -- Agency lifecycle — UX Gap Analysis §10.
  status      text not null default 'registering' check (status in (
                'registering', 'documents_submitted', 'in_review', 'more_info_needed', 'rejected',
                'approved', 'fee_pending', 'setting_up', 'live', 'overdue', 'offboarding', 'offboarded')),
  paystack_subaccount text,
  plan_code   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger agencies_updated before update on agencies for each row execute function set_updated_at();

create table agency_documents (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null references agencies(id),
  kind        text not null,
  storage_key text not null,
  status      text not null default 'submitted' check (status in ('submitted', 'accepted', 'rejected')),
  review_note text,
  reviewed_by uuid references users(id),
  expires_on  date,
  created_at  timestamptz not null default now()
);

create table stations (
  id           uuid primary key default gen_random_uuid(),
  agency_id    uuid not null references agencies(id),
  name         text not null,
  location_id  uuid references locations(id),
  head_user_id uuid references users(id),
  phone        text,
  accept_window_seconds smallint not null default 25 check (accept_window_seconds between 10 and 120),
  min_on_duty  smallint not null default 1,
  status       text not null default 'draft' check (status in ('draft', 'invite_sent', 'active', 'paused')),
  zone         geography(polygon, 4326),
  created_at   timestamptz not null default now()
);
create unique index on stations (location_id) where location_id is not null;

create table station_areas (
  station_id uuid not null references stations(id),
  level      text not null check (level in ('district', 'area')),
  area_id    text not null,
  primary key (station_id, level, area_id)
);

create table officers (
  user_id     uuid primary key references users(id),
  station_id  uuid not null references stations(id),
  badge_no    text not null,
  rank        text,
  badge_status text not null default 'pending' check (badge_status in ('pending', 'verified', 'expired', 'rejected')),
  badge_expires_on date,
  on_duty     boolean not null default false,
  last_location geography(point, 4326),
  last_location_at timestamptz,
  unique (station_id, badge_no)
);

create table duty_shifts (
  id          uuid primary key default gen_random_uuid(),
  officer_id  uuid not null references officers(user_id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  kind        text not null check (kind in ('day', 'night', 'off', 'leave')),
  vehicle_ref text,
  check (ends_at > starts_at)
);

create table technicians (
  user_id      uuid primary key references users(id),
  vetted_at    timestamptz,
  vetting_ref  text,
  active       boolean not null default true
);

create table routing_rules (
  id              uuid primary key default gen_random_uuid(),
  incident_type   text not null,
  area_id         text,
  station_id      uuid not null references stations(id),
  priority        smallint not null default 1,
  wait_seconds    smallint not null default 25,
  next_station_id uuid references stations(id),
  parallel_units  text[] not null default '{}',
  unique (incident_type, area_id, priority)
);

-- Invites for officers, heads, staff, household members and technicians (B10).
create table invites (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('officer', 'head', 'dispatcher', 'agency_staff', 'platform_staff', 'household_member', 'technician')),
  scope_type   text not null,
  scope_id     uuid,
  phone        text,
  email        citext,
  invited_by   uuid not null references users(id),
  token_hash   text not null unique,
  status       text not null default 'sent' check (status in ('sent', 'opened', 'verifying', 'pending_approval', 'active', 'expired', 'revoked')),
  expires_at   timestamptz not null,
  accepted_user_id uuid references users(id),
  created_at   timestamptz not null default now(),
  check (phone is not null or email is not null)
);
