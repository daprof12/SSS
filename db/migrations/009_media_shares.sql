-- Photos and short videos on tips, public issues and live reports; expiring
-- view-only links for public issue briefs (Public Issues doc §2).

create table media (
  id           uuid primary key default gen_random_uuid(),
  owner_type   text not null check (owner_type in ('tip', 'issue_case', 'incident')),
  owner_id     uuid not null,
  uploader_id  uuid not null references users(id),
  kind         text not null check (kind in ('photo', 'video')),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime')),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 10 * 1024 * 1024),   -- States doc: up to [10] MB
  sha256       text,
  state        text not null default 'pending' check (state in ('pending', 'ready', 'rejected')),
  storage_key  text not null unique,
  created_at   timestamptz not null default now()
);
create index on media (owner_type, owner_id) where state = 'ready';

-- Development store only. Production keeps bytes in encrypted object storage (TRD).
create table media_blobs (
  storage_key text primary key references media(storage_key),
  bytes       bytea not null
);

create table issue_shares (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references issue_cases(id),
  agency_id    uuid not null references agencies(id),
  token_hash   text not null unique,
  note         text not null check (char_length(note) between 3 and 1000),
  created_by   uuid not null references users(id),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  view_count   integer not null default 0,
  last_viewed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index on issue_shares (case_id);
