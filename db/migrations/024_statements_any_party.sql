-- Statements from anyone on a report (traditional statement processing, digitised): the
-- complainant, a victim, a witness, a suspect (cautionary statement) or a responding officer.
-- The station, the agency or an officer on the report asks for it; the person writes it on their
-- phone, or an officer takes it in person and the person confirms it with a code sent to them.

alter table statements
  add column role text not null default 'complainant' check (role in ('complainant', 'victim', 'witness', 'suspect', 'officer')),
  add column mode text not null default 'self' check (mode in ('self', 'in_person')),
  add column agency_id uuid references agencies(id),
  -- In person: who took it down, where, and who else was there (a suspect's lawyer or chosen person).
  add column taken_by uuid references users(id),
  add column taken_at_place text,
  add column present_name text,
  add column present_relation text,
  add column caution_given_at timestamptz,
  add column sign_code_hash text,
  add column sign_code_expires_at timestamptz,
  add column sign_code_tries smallint not null default 0;
update statements s set agency_id = i.agency_id from incidents i where i.id = s.incident_id;

-- A suspect's statement in person needs someone present (ACJA 2015 s.17).
alter table statements add constraint statements_suspect_present
  check (role <> 'suspect' or mode <> 'in_person' or present_name is not null);

alter table statement_versions drop constraint statement_versions_signed_with_check;
alter table statement_versions add constraint statement_versions_signed_with_check check (signed_with in ('pin', 'biometric', 'phone_code'));
alter table statement_versions
  add column taken_by uuid references users(id),
  add column role text,
  add column present_name text;

alter table statement_access drop constraint statement_access_action_check;
alter table statement_access add constraint statement_access_action_check
  check (action in ('opened', 'downloaded', 'detail_requested', 'translator_check', 'shared', 'shared_opened', 'code_sent', 'taken_in_person'));
