-- Stolen-item registry: item types set by platform admins, items citizens register as theirs,
-- stolen reports the police work to recovery, and buyer checks ("check before you buy").
-- Checks and case events are append-only: a match is evidence and is never edited.

create table item_types (
  code             text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  label            text not null check (char_length(label) between 2 and 40),
  icon             text not null default 'other',
  identifier_label text not null check (char_length(identifier_label) between 2 and 40),
  identifier_hint  text not null default '',
  -- {minLength, maxLength, charset: digits|alnum|vin, checksum: none|luhn|vin, pattern?}
  rule             jsonb not null,
  -- [{code, label, required}]: proof the owner gives when registering.
  documents        jsonb not null default '[]',
  active           boolean not null default true,
  sort             integer not null default 100,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

insert into item_types (code, label, icon, identifier_label, identifier_hint, rule, documents, sort) values
  ('phone', 'Phone', 'phone', 'IMEI', 'Dial *#06# to see it. 15 digits. Phones with two SIMs have two; use the first.',
   '{"minLength": 15, "maxLength": 15, "charset": "digits", "checksum": "luhn"}',
   '[{"code": "receipt", "label": "Receipt or proof of purchase", "required": true}]', 10),
  ('car', 'Car', 'road', 'Chassis number (VIN)', '17 letters and numbers, on the dashboard by the windscreen and on the vehicle papers.',
   '{"minLength": 17, "maxLength": 17, "charset": "vin", "checksum": "none"}',
   '[{"code": "ownership", "label": "Proof of ownership (vehicle licence)", "required": true}, {"code": "receipt", "label": "Purchase receipt", "required": false}]', 20),
  ('laptop', 'Laptop', 'article', 'Serial number', 'On a sticker under the laptop, or in its settings under About.',
   '{"minLength": 5, "maxLength": 30, "charset": "alnum", "checksum": "none"}',
   '[{"code": "receipt", "label": "Receipt or proof of purchase", "required": true}]', 30);

-- What a citizen owns. The identifier is stored cleaned (upper case, no spaces or dashes).
create table owned_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id),
  type_code   text not null references item_types(code),
  identifier  text not null check (identifier ~ '^[A-Z0-9]{3,64}$'),
  make        text check (char_length(make) <= 60),
  model       text check (char_length(model) <= 60),
  colour      text check (char_length(colour) <= 40),
  description text check (char_length(description) <= 500),
  -- registered: in the owner's list. unregistered: created by a stolen report for an item never registered.
  registered  boolean not null default true,
  removed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index owned_items_one_per_owner on owned_items (owner_id, type_code, identifier) where removed_at is null;
create index on owned_items (type_code, identifier) where removed_at is null;

create table stolen_cases (
  id               uuid primary key default gen_random_uuid(),
  public_no        text not null unique,
  item_id          uuid not null references owned_items(id),
  reporter_id      uuid not null references users(id),
  type_code        text not null references item_types(code),
  identifier       text not null,
  state            text not null default 'reported' check (state in ('reported', 'investigating', 'located', 'recovered', 'returned', 'closed', 'withdrawn')),
  stolen_on        date not null,
  circumstances    text check (char_length(circumstances) <= 1000),
  police_report_no text check (char_length(police_report_no) <= 40),
  location_id      uuid references locations(id),
  geom             geography(point, 4326) not null,
  agency_id        uuid references agencies(id),
  agency_label     text not null,
  station_id       uuid references stations(id),
  -- Someone else has the same identifier registered as theirs: the police check both proofs.
  ownership_conflict boolean not null default false,
  client_ref       text not null,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (reporter_id, client_ref)
);
-- One open case per item, and fast lookups for buyer checks.
create unique index stolen_cases_one_open on stolen_cases (item_id) where state in ('reported', 'investigating', 'located');
create index stolen_cases_lookup on stolen_cases (type_code, identifier) where state in ('reported', 'investigating', 'located');
create index on stolen_cases (agency_id, created_at desc);

-- Append-only case log: state changes, police notes, matches reviewed, buyer details added.
create table stolen_case_events (
  id         bigserial primary key,
  case_id    uuid not null references stolen_cases(id),
  kind       text not null,
  actor_kind text not null check (actor_kind in ('owner', 'agency', 'checker', 'system')),
  actor_id   uuid,
  from_state text,
  to_state   text,
  payload    jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index on stolen_case_events (case_id, id);
create trigger stolen_case_events_immutable before update or delete on stolen_case_events for each row execute function forbid_change();

-- Every buyer check, clean or not. A check on a stolen item (result 'stolen') is a match passed to the police.
create table item_checks (
  id          uuid primary key default gen_random_uuid(),
  check_no    text not null unique,
  checker_id  uuid not null references users(id),
  type_code   text not null references item_types(code),
  identifier  text not null,
  result      text not null check (result in ('clean', 'stolen')),
  case_id     uuid references stolen_cases(id),
  context     text not null default 'buying' check (context in ('buying', 'repairing', 'found', 'other')),
  location_id uuid references locations(id),
  geom        geography(point, 4326),
  accuracy_m  integer,
  -- The police agency and station nearest to where the check was made.
  agency_id   uuid references agencies(id),
  station_id  uuid references stations(id),
  ip          text,
  user_agent  text,
  at          timestamptz not null default now(),
  check ((result = 'stolen') = (case_id is not null))
);
create index on item_checks (checker_id, at desc);
create index on item_checks (case_id) where case_id is not null;
create index on item_checks (agency_id, at desc) where result = 'stolen';
create trigger item_checks_immutable before update or delete on item_checks for each row execute function forbid_change();

-- Photos and proof documents on registered items and stolen reports. A document (receipt, vehicle
-- licence) is a photo or a PDF and says which of the type's documents it is.
alter table media add column doc_code text check (doc_code ~ '^[a-z][a-z0-9_]{1,30}$');
alter table media drop constraint media_owner_type_check;
alter table media add constraint media_owner_type_check check (owner_type in (
  'tip', 'issue_case', 'incident', 'learn_post', 'field_report', 'fine', 'repair', 'statement', 'owned_item', 'stolen_case'));
alter table media drop constraint media_kind_check;
alter table media add constraint media_kind_check check (kind in ('photo', 'video', 'voice', 'document'));
alter table media drop constraint media_content_type_check;
alter table media add constraint media_content_type_check check (content_type in (
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'application/pdf'));
