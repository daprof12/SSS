-- Tips and public issues go to the agency and station that cover the place, like emergencies.
alter table tips add column station_id uuid references stations(id);
alter table issue_cases add column station_id uuid references stations(id);
create index on tips (station_id);
create index on issue_cases (station_id);
