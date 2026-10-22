-- An agency's logo, shown on its dashboards, its stations' dashboards and its officers' app.
-- Small images only; served publicly by agency id (a logo is not private).
create table agency_logos (
  agency_id    uuid primary key references agencies(id),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea not null check (octet_length(bytes) <= 512 * 1024),
  sha          text not null,
  updated_by   uuid references users(id),
  updated_at   timestamptz not null default now()
);
