-- Incidents, reports, response log and tracking. States match packages/domain/src/incident.ts.
create table incident_types (
  code          text primary key,
  label         text not null,
  family        text not null,
  default_units text[] not null,
  severity      smallint not null default 2,
  pays_bounty   boolean not null default false
);

insert into incident_types (code, label, family, default_units, severity) values
  ('fire', 'Fire', 'fire', '{fire}', 3),
  ('robbery', 'Robbery', 'crime', '{police}', 3),
  ('kidnapping', 'Kidnapping', 'crime', '{police}', 4),
  ('riot', 'Riot', 'crime', '{police}', 3),
  ('violence', 'Homicide or violence', 'crime', '{police,health}', 4),
  ('medical', 'Medical', 'health', '{health}', 3),
  ('accident', 'Accident', 'road', '{frsc,health}', 3),
  ('other', 'Other danger', 'other', '{police}', 2);

create table incidents (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references users(id),
  type          text not null references incident_types(code),
  location_id   uuid references locations(id),
  property_id   uuid references properties(id),
  geom          geography(point, 4326) not null,
  state         text not null default 'pending_cancel' check (state in (
                  'pending_cancel', 'received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning',
                  'transferred', 'on_scene', 'closing', 'resolved', 'unfounded', 'cancelled', 'merged')),
  severity      smallint not null default 2,
  source        text not null default 'app' check (source in ('app', 'sms', 'ussd', 'device', 'sos_no_account')),
  agency_id     uuid references agencies(id),
  station_id    uuid references stations(id),
  merged_into   uuid references incidents(id),
  merge_reason  text check (merge_reason in ('same_building', 'dispatcher')),
  report_count  integer not null default 1,
  outcome_code  text,
  cancel_flagged boolean not null default false,
  discreet      boolean not null default false,
  eta_minutes   smallint,
  version       integer not null default 0,
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,
  check (state <> 'merged' or merged_into is not null),
  check (state not in ('resolved', 'unfounded') or outcome_code is not null)
);
create index on incidents using gist (geom);
create index on incidents (state, created_at desc);
create index on incidents (station_id, state);
create trigger incidents_updated before update on incidents for each row execute function set_updated_at();

-- One row per person's report on the incident (TRD duplicates). delivery_state is that sender's layer (A1).
create table incident_reports (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid not null references incidents(id),
  reporter_id    uuid references users(id),
  device_id      uuid,
  source         text not null check (source in ('app', 'sms', 'device')),
  role           text not null check (role in ('first', 'joined', 'device')),
  type_chosen    text not null references incident_types(code),
  answers        jsonb not null default '{}',
  delivery_state text not null default 'submitted' check (delivery_state in ('sending', 'queued_offline', 'sms_sent', 'submitted', 'failed')),
  client_ref     text unique,                           -- idempotency key from the device queue
  created_at     timestamptz not null default now()
);
create index on incident_reports (incident_id);
create index on incident_reports (reporter_id, created_at desc);

create table incident_units (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id),
  station_id  uuid not null references stations(id),
  officer_id  uuid references officers(user_id),
  role        text not null check (role in ('primary', 'reinforcement', 'parallel', 'transfer')),
  state       text not null default 'offered' check (state in ('offered', 'accepted', 'declined', 'expired', 'taken', 'dropped', 'en_route', 'on_scene', 'released')),
  decline_reason text,
  offered_at  timestamptz not null default now(),
  offer_expires_at timestamptz,
  accepted_at timestamptz,
  arrived_at  timestamptz
);
create index on incident_units (incident_id);
create index on incident_units (officer_id, state);

-- Append-only response log (DISP-5).
create table incident_events (
  id          bigserial primary key,
  incident_id uuid not null references incidents(id),
  actor_id    uuid,
  actor_kind  text not null check (actor_kind in ('reporter', 'officer', 'station', 'platform_admin', 'system')),
  kind        text not null,
  from_state  text,
  to_state    text,
  payload     jsonb not null default '{}',
  public      boolean not null default false,
  geom        geography(point, 4326),
  at          timestamptz not null default now()
);
create index on incident_events (incident_id, id);
create trigger incident_events_immutable before update or delete on incident_events for each row execute function forbid_change();

create table incident_briefs (
  incident_id   uuid primary key references incidents(id),
  fields        jsonb not null,
  confidence    jsonb not null,
  model_version text not null,
  edited_by     uuid references users(id),
  updated_at    timestamptz not null default now()
);

create table incident_media (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id),
  device_id   uuid,
  uploaded_by uuid references users(id),
  storage_key text not null,
  kind        text not null check (kind in ('clip', 'photo', 'voice', 'text')),
  expires_at  timestamptz not null,
  hold        boolean not null default false,
  created_at  timestamptz not null default now()
);

create table ratings (
  incident_id uuid not null references incidents(id),
  reporter_id uuid not null references users(id),
  stars       smallint not null check (stars between 1 and 5),
  tags        text[] not null default '{}',
  comment     text check (char_length(comment) <= 1000),
  created_at  timestamptz not null default now(),
  primary key (incident_id, reporter_id)
);

create table incident_links (
  a_id uuid not null references incidents(id),
  b_id uuid not null references incidents(id),
  reason text not null,
  primary key (a_id, b_id),
  check (a_id < b_id)
);

create table merge_suggestions (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id),
  candidate_id uuid not null references incidents(id),
  distance_m  integer not null,
  gap_seconds integer not null,
  state       text not null default 'open' check (state in ('open', 'merged', 'kept_separate')),
  decided_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

-- Time-limited links for emergency contacts (area only, decided 2026-10-17).
create table tracking_links (
  token_hash  text primary key,
  incident_id uuid not null references incidents(id),
  contact_id  uuid not null references emergency_contacts(id),
  share_location boolean not null default false,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table camera_access_log (
  id          bigserial primary key,
  device_id   uuid not null,
  actor_id    uuid not null references users(id),
  actor_role  text not null,
  reason      text not null check (char_length(reason) >= 3),
  incident_id uuid references incidents(id),
  at          timestamptz not null default now()
);
create trigger camera_access_log_immutable before update or delete on camera_access_log for each row execute function forbid_change();

create table false_alarm_cases (
  incident_id uuid primary key references incidents(id),
  verdict     text not null check (verdict in ('valid', 'unfounded', 'malicious')),
  evidence    jsonb not null default '{}',
  decided_by  uuid not null references users(id),
  decided_at  timestamptz not null default now()
);

create table fines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  incident_id uuid references incidents(id),
  amount_kobo bigint not null check (amount_kobo > 0),
  state       text not null default 'open' check (state in ('open', 'appealed', 'waived', 'reduced', 'upheld', 'paid')),
  appeal_by   timestamptz not null,
  appeal_reason text check (appeal_reason is null or char_length(appeal_reason) between 20 and 1000),
  decided_by  uuid references users(id),
  decision_reason text,
  created_at  timestamptz not null default now()
);
