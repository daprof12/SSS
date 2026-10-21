-- Roster swap and leave requests (board "Station roster": Swap requests), and station messages by
-- SMS and WhatsApp as well as push (board "Station messages": Push, SMS if not opened, WhatsApp).

create table roster_requests (
  id              uuid primary key default gen_random_uuid(),
  station_id      uuid not null references stations(id),
  officer_id      uuid not null references users(id),
  kind            text not null check (kind in ('swap', 'leave')),
  -- swap: my shift on my_date for other_officer's shift on other_date
  other_officer_id uuid references users(id),
  my_date         date,
  other_date      date,
  -- leave: from_date to to_date, inclusive
  from_date       date,
  to_date         date,
  note            text,
  state           text not null default 'waiting' check (state in ('waiting', 'approved', 'declined', 'withdrawn')),
  decided_by      uuid references users(id),
  decided_at      timestamptz,
  decline_reason  text,
  created_at      timestamptz not null default now(),
  check (kind <> 'swap' or (other_officer_id is not null and my_date is not null and other_date is not null)),
  check (kind <> 'leave' or (from_date is not null and to_date is not null and to_date >= from_date))
);

-- Staff choose WhatsApp; SMS goes to anyone with a phone when a push is not opened in time.
alter table users add column whatsapp_opt_in boolean not null default false;
alter table station_broadcasts add column sms_after_minutes smallint;
alter table station_broadcast_recipients
  add column sms_at timestamptz,
  add column whatsapp_at timestamptz,
  add column failed_at timestamptz,
  add column failure text;
