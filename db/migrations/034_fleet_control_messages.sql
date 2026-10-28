-- Smart-device fleet and the control centre, plus report messages between a citizen and the officers on it.

-- Product range: the smart pole (street light, camera, solar panel, alarm, sensors, drone dock), the two drones,
-- officer body cam and the retrofit sensor and alarm. 'drone' stays for older rows.
alter table devices drop constraint devices_type_check;
alter table devices add constraint devices_type_check check (type in (
  'camera', 'street_light', 'gateway', 'drone', 'smart_pole', 'defence_drone', 'fire_drone', 'body_cam', 'sensor'));
alter table store_stock drop constraint store_stock_item_check;
alter table store_stock add constraint store_stock_item_check check (item in (
  'camera', 'street_light', 'gateway', 'drone', 'battery', 'solar_panel', 'pole', 'smart_pole', 'defence_drone', 'fire_drone', 'body_cam', 'sensor'));

-- Public devices an agency or station operates (as opposed to household devices a citizen subscribes to).
alter table devices
  add column agency_id  uuid references agencies(id),
  add column station_id uuid references stations(id),
  add column officer_id uuid references users(id),            -- who wears the body cam
  add column lat        double precision,
  add column lng        double precision,
  add column state      text not null default 'standby',      -- drones: standby, deployed, returning; poles: siren on or off
  add column linked_to  uuid references devices(id);          -- a drone docked on a smart pole
create index on devices (agency_id) where agency_id is not null;

-- Set by a platform admin when onboarding: this agency may see and operate smart devices from its control centre.
alter table agencies add column device_access boolean not null default false;

create table device_commands (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references devices(id),
  agency_id   uuid references agencies(id),
  incident_id uuid references incidents(id),
  issued_by   uuid not null references users(id),
  command     text not null check (command in ('deploy', 'recall', 'goto_scene', 'siren_on', 'siren_off', 'light_on', 'light_off', 'stream_start', 'stream_stop')),
  status      text not null default 'sent' check (status in ('sent', 'done', 'failed')),
  result      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index on device_commands (device_id, created_at desc);
create index on device_commands (incident_id) where incident_id is not null;

create table incident_messages (
  id          bigserial primary key,
  incident_id uuid not null references incidents(id),
  sender_id   uuid not null references users(id),
  side        text not null check (side in ('citizen', 'responder')),
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index on incident_messages (incident_id, id);
