-- Jurisdiction routing and the remaining platform admin boards ("Coverage map", "Device wall",
-- "Inventory", "Agencies", "Audit log", "AI and LLM", "Messaging", "Donations and payouts").

-- A station can cover a whole LGA as well as districts and areas.
alter table station_areas drop constraint station_areas_level_check;
alter table station_areas add constraint station_areas_level_check check (level in ('lga', 'district', 'area'));
alter table station_areas add column label text;

-- Inventory: stores, what each holds, and every movement in or between them.
create table stores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  location_id uuid references locations(id),
  created_at  timestamptz not null default now()
);
create table store_stock (
  store_id   uuid not null references stores(id),
  item       text not null check (item in ('camera', 'street_light', 'gateway', 'drone', 'battery', 'solar_panel', 'pole')),
  quantity   integer not null default 0 check (quantity >= 0),
  reorder_at integer not null default 5 check (reorder_at >= 0),
  primary key (store_id, item)
);
create table stock_moves (
  id         bigserial primary key,
  item       text not null,
  quantity   integer not null check (quantity > 0),
  from_store uuid references stores(id),
  to_store   uuid references stores(id),
  note       text,
  actor_id   uuid not null references users(id),
  at         timestamptz not null default now(),
  check (from_store is not null or to_store is not null),
  check (from_store is distinct from to_store)
);

-- Donations: each gift is paid out to its recipient on the next payout run.
alter table donations
  add column payout_state   text not null default 'queued' check (payout_state in ('queued', 'paid', 'failed')),
  add column paid_out_at    timestamptz,
  add column payout_failure text;

-- AI: where it is used, which model tier runs it and how often a person checks it.
create table ai_use_cases (
  code       text primary key,
  name       text not null,
  tier       text not null check (tier in ('primary', 'small', 'vision')),
  mode       text not null,
  check_pct  smallint not null check (check_pct between 0 and 100),
  status     text not null default 'live' check (status in ('live', 'testing', 'paused')),
  sort       smallint not null default 0
);
insert into ai_use_cases (code, name, tier, mode, check_pct, status, sort) values
  ('brief', 'Incident briefing for the agency', 'primary', 'Auto, officer confirms', 10, 'live', 1),
  ('translate', 'Statement translation to English', 'primary', 'Reporter signs it', 100, 'live', 2),
  ('tip_match', 'Tip sorting and agency match', 'primary', 'Agency decides', 100, 'live', 3),
  ('duplicates', 'Duplicate and merge suggestions', 'small', 'Officer confirms', 100, 'live', 4),
  ('false_alarm', 'False-alarm check', 'small', 'Staff decide fines', 100, 'live', 5),
  ('clip_summary', 'Camera clip summary', 'vision', 'Auto, flagged to staff', 20, 'testing', 6),
  ('crm_draft', 'Message drafts for CRM', 'primary', 'Sender approves', 100, 'live', 7),
  ('learn_draft', 'Learn feed writing', 'primary', 'Editor approves', 100, 'paused', 8);
create table ai_requests (
  id         bigserial primary key,
  use_case   text not null references ai_use_cases(code),
  ms         integer not null,
  failed     boolean not null default false,
  to_review  boolean not null default false,
  cost_kobo  integer not null default 0,
  language   text,
  at         timestamptz not null default now()
);
create index on ai_requests (at desc);
insert into platform_settings (key, value) values
  ('ai', '{"provider": "Anthropic", "primary": "claude-opus-5-5", "fallback": "claude-haiku-5-5", "region": "eu-west", "paused": false, "translationPaused": false, "useFallback": false, "monthlyLimitKobo": 50000000, "reviewBelowPct": 80}'),
  ('ai_languages', '{"en": "good", "pcm": "test_needed", "yo": "test_needed", "ha": "test_needed", "ig": "test_needed"}')
on conflict (key) do nothing;

-- CRM messaging: a campaign, its audience, and what reached each person.
create table crm_campaigns (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(title) between 1 and 120),
  body         text not null check (char_length(body) between 1 and 1000),
  kind         text not null default 'marketing' check (kind in ('marketing', 'safety')),
  urgent       boolean not null default false,
  audience     jsonb not null default '{}',
  channels     text[] not null default '{push}',
  languages    text[] not null default '{en}',
  link         text,
  state        text not null default 'draft' check (state in ('draft', 'awaiting_approval', 'scheduled', 'sent', 'cancelled')),
  send_at      timestamptz,
  created_by   uuid not null references users(id),
  approved_by  uuid references users(id),
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  check (approved_by is null or approved_by <> created_by)
);
create table crm_deliveries (
  campaign_id     uuid not null references crm_campaigns(id),
  user_id         uuid not null references users(id),
  notification_id uuid references notifications(id),
  pushed_at       timestamptz,
  sms_at          timestamptz,
  whatsapp_at     timestamptz,
  read_at         timestamptz,
  failure         text check (failure in ('number_not_valid', 'phone_off', 'opted_out', 'whatsapp_not_opted_in', 'dnd', 'no_channel')),
  primary key (campaign_id, user_id)
);

-- Field visits booked from the device wall.
alter table install_jobs add column note text;

-- AI review queue: a person's decision on a low-confidence statement translation. The signed
-- record never changes; a translator check or a re-record makes a new version.
create table ai_reviews (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references statements(id),
  version      integer not null,
  decision     text not null check (decision in ('looks_right', 'note', 'translator', 'rerecord')),
  note         text,
  decided_by   uuid not null references users(id),
  decided_at   timestamptz not null default now(),
  unique (statement_id, version)
);
