-- Officer "Report" tab (board "Officer report and tip"): an incident report filed from the
-- field, optionally linked to an incident the officer is on. The station sees it.
create table field_reports (
  id          uuid primary key default gen_random_uuid(),
  officer_id  uuid not null references officers(user_id),
  station_id  uuid not null references stations(id),
  type        text not null references incident_types(code),
  location_id uuid references locations(id),
  geom        geography(point, 4326),
  description text not null check (char_length(description) between 10 and 2000),
  incident_id uuid references incidents(id),
  client_ref  text unique,
  created_at  timestamptz not null default now(),
  check (location_id is not null or geom is not null)
);
create index on field_reports (officer_id, created_at desc);
create index on field_reports (station_id, created_at desc);

alter table media drop constraint media_owner_type_check;
alter table media add constraint media_owner_type_check check (owner_type in ('tip', 'issue_case', 'incident', 'learn_post', 'field_report'));
