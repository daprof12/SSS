-- People, roles, security and places.
create table locations (
  id            uuid primary key default gen_random_uuid(),
  postcode      text not null unique,
  building_name text,
  address_text  text not null,
  state_id      text not null,
  lga_id        text not null,
  district_id   text not null,
  area_id       text not null,
  area_label    text not null,
  geom          geography(point, 4326) not null,
  fetched_at    timestamptz not null default now()
);
create index on locations using gist (geom);
create index on locations (state_id, lga_id, district_id, area_id);

create table users (
  id            uuid primary key default gen_random_uuid(),
  phone         text unique,
  email         citext unique,
  display_name  text not null,
  status        text not null default 'active' check (status in ('active', 'blocked', 'suspended', 'deleted')),
  locale        text not null default 'en' check (locale in ('en', 'ha', 'yo', 'ig', 'pcm')),
  theme         text not null default 'system' check (theme in ('system', 'light', 'dark')),
  reduce_motion boolean not null default false,
  discreet_mode boolean not null default false,
  pin_hash      text,
  pin_failed    smallint not null default 0,
  pin_locked_until timestamptz,
  mfa_enabled   boolean not null default false,
  location_id   uuid references locations(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (phone is not null or email is not null)
);
create trigger users_updated before update on users for each row execute function set_updated_at();

create table auth_identities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  provider   text not null check (provider in ('phone', 'email', 'google', 'apple', 'facebook')),
  subject    text not null,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

-- No raw NIN or BVN is ever stored (Security doc).
create table kyc_verifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  provider     text not null,
  provider_ref text not null,
  id_type      text not null check (id_type in ('nin', 'bvn', 'passport', 'drivers_licence', 'voters_card')),
  id_masked    text not null,
  selfie_match numeric(4, 3),
  liveness     boolean,
  status       text not null check (status in ('pending', 'verified', 'failed', 'manual_review')),
  failure_reason text,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index on kyc_verifications (user_id, created_at desc);

create table user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  role       text not null check (role in ('citizen', 'owner', 'officer', 'head', 'dispatcher', 'agency_admin', 'agency_finance', 'platform_admin', 'technician')),
  scope_type text not null check (scope_type in ('platform', 'agency', 'station', 'property', 'self')),
  scope_id   uuid,
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  -- Platform-wide roles have no scope_id; NULLS NOT DISTINCT keeps them unique too.
  unique nulls not distinct (user_id, role, scope_type, scope_id)
);

create table trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  label        text not null,
  platform     text not null,
  public_key   text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  device_id    uuid references trusted_devices(id),
  ip           inet,
  user_agent   text,
  mfa_passed   boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index on sessions (user_id) where revoked_at is null;

create table recovery_codes (
  user_id   uuid not null references users(id),
  code_hash text not null,
  used_at   timestamptz,
  primary key (user_id, code_hash)
);

-- In MVP (decided 2026-10-17). Contacts get area-only tracking links.
create table emergency_contacts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id),
  name          text not null,
  phone         text not null,
  verified_at   timestamptz,
  share_location boolean not null default false,
  include_violence_reports boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (user_id, phone)
);
create or replace function emergency_contacts_max3() returns trigger language plpgsql as $$
begin
  if (select count(*) from emergency_contacts where user_id = new.user_id) >= 3 then
    raise exception 'A user can have at most 3 emergency contacts' using errcode = 'P0002';
  end if;
  return new;
end $$;
create trigger emergency_contacts_limit before insert on emergency_contacts for each row execute function emergency_contacts_max3();

create table saved_places (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  label       text not null,
  location_id uuid not null references locations(id),
  is_home     boolean not null default false,
  verified    boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index on saved_places (user_id) where is_home;

create table properties (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id),
  location_id uuid not null references locations(id),
  ownership   text not null check (ownership in ('owner', 'tenant_with_permission', 'community_lead')),
  verified    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table property_members (
  property_id uuid not null references properties(id),
  user_id     uuid not null references users(id),
  relation    text not null,
  can_view_live boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (property_id, user_id)
);

create table trust_scores (
  user_id    uuid primary key references users(id),
  score      smallint not null default 70 check (score between 0 and 100),
  band       text not null default 'normal' check (band in ('high', 'normal', 'low')),
  updated_at timestamptz not null default now()
);
