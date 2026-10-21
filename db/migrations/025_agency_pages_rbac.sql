-- Agency boards ("Officers", "Inventory", "Routing rules", "Billing", "Infrastructure assets",
-- "Asset detail", "Messaging", "Settings", "Station detail") and role-based access for staff.

-- Staff roles: platform finance, support and field operations alongside platform admin.
alter table user_roles drop constraint user_roles_role_check;
alter table user_roles add constraint user_roles_role_check check (role in (
  'citizen', 'owner', 'officer', 'head', 'dispatcher', 'agency_admin', 'agency_finance',
  'platform_admin', 'platform_finance', 'platform_support', 'platform_ops', 'technician'));

-- Agency settings: phone, email, alerts, routing defaults; a name or type change waits for the platform.
alter table agencies
  add column contact_phone   text,
  add column contact_email   citext,
  add column settings        jsonb not null default
    '{"acceptSeconds": 25, "ifNobodyAccepts": "next_nearest", "nightHandover": "19:00", "alerts": {"noTaker": true, "nobodyOnDuty": true, "payout": true, "weekly": false}, "safetyPlanSigned": false}',
  add column pending_profile jsonb;

-- Officers invited by the agency show as "Invited" until they verify their identity.
alter table officers add column invited_at timestamptz;

-- Equipment: what each item is, its condition and when it was last checked.
alter table agency_inventory
  add column name          text,
  add column status        text not null default 'ready' check (status in ('ready', 'in_use', 'needs_service', 'out_of_service')),
  add column last_check_at timestamptz,
  add column pilot_name    text;

-- Routing rules: on or paused, and who changed them.
alter table routing_rules
  add column active     boolean not null default true,
  add column updated_by uuid references users(id),
  add column updated_at timestamptz not null default now();

-- Infrastructure assets the agency is in charge of: traffic lights, street lights, cameras.
create table agency_assets (
  id             uuid primary key default gen_random_uuid(),
  agency_id      uuid not null references agencies(id),
  kind           text not null check (kind in ('traffic_light', 'street_light', 'camera')),
  name           text not null,
  location_id    uuid references locations(id),
  status         text not null default 'online' check (status in ('online', 'low_power', 'offline', 'fault')),
  fault_detail   text,
  last_signal_at timestamptz,
  power          text,
  battery_pct    smallint check (battery_pct between 0 and 100),
  controller     text,
  installed_on   date,
  last_service_on date,
  next_service_on date,
  warranty_until date,
  signal_plan    jsonb not null default '{}',
  plan_changed_at timestamptz,
  plan_changed_by uuid references users(id),
  created_at     timestamptz not null default now(),
  unique (agency_id, name)
);
create table asset_faults (
  id         bigserial primary key,
  asset_id   uuid not null references agency_assets(id),
  what       text not null,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  fix        text
);
create table asset_work_orders (
  id         uuid primary key default gen_random_uuid(),
  number     text not null unique,
  asset_id   uuid not null references agency_assets(id),
  kind       text not null check (kind in ('repair', 'service', 'inspection', 'replace')),
  note       text,
  state      text not null default 'open' check (state in ('open', 'in_progress', 'done', 'cancelled')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
-- Remote actions on a traffic light need the safety plan signed and a second approver.
create table asset_actions (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references agency_assets(id),
  action       text not null check (action in ('restart', 'flashing_amber', 'manual_control')),
  requested_by uuid not null references users(id),
  approved_by  uuid references users(id),
  state        text not null default 'awaiting_approval' check (state in ('awaiting_approval', 'done', 'refused')),
  created_at   timestamptz not null default now(),
  check (approved_by is null or approved_by <> requested_by)
);

-- Agency messaging uses the same campaigns, scoped to the agency.
alter table crm_campaigns add column agency_id uuid references agencies(id);

-- Fire services carry drop kits; billed like other equipment.
insert into agency_fees (code, label, amount_kobo, cycle) values ('inventory_fire_kit', 'Fire drop kit', 300000, 'per_item_monthly') on conflict do nothing;
