-- Statements (B7), the station's review of a false-alarm closure before any fine (B8 step 1,
-- decided 2026-10-21: 48 hours, silence means it goes ahead), the fine money split
-- (40% agency, 30% rewards pool, 30% platform), and staff replies to help messages.

-- ---------------------------------------------------------------- statements (B7)
create table statements (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique,
  incident_id   uuid not null references incidents(id),
  citizen_id    uuid not null references users(id),
  station_id    uuid references stations(id),
  requested_by  uuid not null references users(id),
  request_note  text,
  state         text not null default 'requested' check (state in ('requested', 'draft', 'signed', 'change_requested')),
  -- Working draft (before signing): what they said, the language, the AI English record.
  draft_language text,
  draft_original text,
  draft_english  text,
  draft_confidence numeric(4, 3),
  draft_flagged  text[] not null default '{}',
  draft_audio_id uuid,
  change_note   text,
  translator_check text check (translator_check in ('requested', 'done')),
  translator_note  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (incident_id, citizen_id)
);
create trigger statements_updated before update on statements for each row execute function set_updated_at();

-- Each signed version is sealed and never changed; a correction is a new version.
create table statement_versions (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references statements(id),
  version      smallint not null,
  language     text not null,
  original_text text not null,
  english_text text not null,
  ai_confidence numeric(4, 3),
  flagged_words text[] not null default '{}',
  audio_id     uuid,
  signed_with  text not null check (signed_with in ('pin', 'biometric')),
  seal         text not null,
  signed_at    timestamptz not null default now(),
  unique (statement_id, version)
);
create trigger statement_versions_immutable before update or delete on statement_versions for each row execute function forbid_change();

create table statement_access (
  id           bigserial primary key,
  statement_id uuid not null references statements(id),
  actor_id     uuid references users(id),
  action       text not null check (action in ('opened', 'downloaded', 'detail_requested', 'translator_check', 'shared', 'shared_opened')),
  note         text,
  at           timestamptz not null default now()
);
create index on statement_access (statement_id, at);

create table statement_shares (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references statements(id),
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

alter table media drop constraint media_owner_type_check;
alter table media add constraint media_owner_type_check check (owner_type in ('tip', 'issue_case', 'incident', 'learn_post', 'field_report', 'fine', 'repair', 'statement'));

-- ---------------------------------------------------------------- false alarm: station review, then policy
alter table false_alarm_cases
  add column review_state text not null default 'pending' check (review_state in ('pending', 'confirmed', 'overturned', 'auto_confirmed')),
  add column review_due_at timestamptz not null default now() + interval '48 hours',
  add column reviewed_by uuid references users(id),
  add column reviewed_at timestamptz,
  add column review_note text;
-- Cases from before the review step were acted on already.
update false_alarm_cases set review_state = 'auto_confirmed', reviewed_at = decided_at
 where incident_id in (select incident_id from fines union select incident_id from false_alarm_warnings);

-- Who gets the fine money (B9 "Fine payment: citizen → platform, agency share").
alter table fines add column agency_id uuid references agencies(id), add column shares jsonb not null default '[]';

-- ---------------------------------------------------------------- help replies
alter table support_tickets
  add column replied_by uuid references users(id),
  add column replied_at timestamptz,
  add column assigned_to uuid references users(id);
