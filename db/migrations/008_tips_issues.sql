-- Tips → bounty (Report Tracking B2) and public issues (B3; Public Issues doc §1–2).

-- Tips can be withdrawn by the tipper before a result (board "Tip detail").
alter table tips drop constraint tips_state_check;
alter table tips add constraint tips_state_check check (state in (
  'sent', 'in_queue', 'more_info', 'claim_review', 'approved_held', 'available', 'declined', 'closed_no_result', 'found_false', 'withdrawn'));
alter table tips
  add column details     jsonb not null default '{}',
  add column agency_label text,                         -- what the tipper was told ("NAPTIP"), even before the agency joins
  add column updated_at  timestamptz not null default now();

-- The tip's own timeline. Tipper sees public rows; the agency never sees the tipper's identity here.
create table tip_events (
  id      bigserial primary key,
  tip_id  uuid not null references tips(id),
  kind    text not null,
  actor_kind text not null check (actor_kind in ('tipper', 'agency', 'platform', 'system')),
  payload jsonb not null default '{}',
  public  boolean not null default true,
  at      timestamptz not null default now()
);
create index on tip_events (tip_id, id);
create trigger tip_events_immutable before update or delete on tip_events for each row execute function forbid_change();

-- Public issue cases: reports of the same thing nearby merge into one case with a count.
create table issue_cases (
  id            uuid primary key default gen_random_uuid(),
  public_no     text not null unique,
  category      text not null,
  agency_id     uuid references agencies(id),
  agency_label  text not null,
  location_id   uuid references locations(id),
  geom          geography(point, 4326) not null,
  state         text not null default 'open' check (state in ('open', 'assigned', 'in_progress', 'awaiting_check', 'fixed', 'reopened')),
  severity      text not null default 'small' check (severity in ('small', 'dangerous', 'blocking')),
  report_count  integer not null default 1,
  people_count  integer not null default 1,
  first_at      timestamptz not null default now(),
  last_at       timestamptz not null default now(),
  target_on     date,
  fix_note      text,
  fixed_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on issue_cases using gist (geom);
create index on issue_cases (category, state);
create index on issue_cases (agency_id, state);

create table issue_reports (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references issue_cases(id),
  user_id     uuid not null references users(id),
  subtype     text,
  severity    text not null check (severity in ('small', 'dangerous', 'blocking')),
  description text check (description is null or char_length(description) <= 1000),
  anonymous   boolean not null default false,
  fixed_vote  text check (fixed_vote in ('yes', 'no')),
  voted_at    timestamptz,
  client_ref  text unique,
  created_at  timestamptz not null default now()
);
create index on issue_reports (case_id);
create index on issue_reports (user_id, created_at desc);

create table issue_events (
  id      bigserial primary key,
  case_id uuid not null references issue_cases(id),
  kind    text not null,
  actor_kind text not null check (actor_kind in ('citizen', 'agency', 'platform', 'system')),
  payload jsonb not null default '{}',
  at      timestamptz not null default now()
);
create index on issue_events (case_id, id);
create trigger issue_events_immutable before update or delete on issue_events for each row execute function forbid_change();
