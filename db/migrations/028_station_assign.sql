-- Station assign and reassign: who put an officer on a report, how, and why; and the officer's
-- "can't go" answer to a direct assignment. A withdrawn offer (the station chose someone else)
-- does not count against the officer, and neither does "can't go".
alter table incident_units drop constraint incident_units_state_check;
alter table incident_units add constraint incident_units_state_check
  check (state in ('offered', 'accepted', 'declined', 'expired', 'taken', 'dropped', 'en_route', 'on_scene', 'released', 'withdrawn', 'cant_go'));
alter table incident_units
  add column assign_mode text check (assign_mode in ('offer', 'direct', 'reassign')),
  add column assigned_by uuid references users(id),
  add column assign_reason text,
  add column cant_go_reason text,
  add column ended_at timestamptz;
