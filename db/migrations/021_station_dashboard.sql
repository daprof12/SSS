-- Station dashboard (boards "Station roster", "Station messages", "Station settings").

-- Shift times, opening hours and alert choices the station head sets.
alter table stations add column settings jsonb not null default
  '{"dayStart": "06:00", "nightStart": "18:00", "openingHours": "always", "ifNobodyAccepts": "next_officer_then_station", "alerts": {"newOffer": true, "nobodyAccepted": true, "tamper": true, "dailySummary": false}}';
alter table stations add column roster_published_at timestamptz;

-- Messages from the station to its officers, with who read and who confirmed.
create table station_broadcasts (
  id           uuid primary key default gen_random_uuid(),
  station_id   uuid not null references stations(id),
  sender_id    uuid not null references users(id),
  audience     text not null check (audience in ('on_duty', 'everyone', 'officer')),
  title        text not null check (char_length(title) between 1 and 120),
  body         text not null check (char_length(body) between 1 and 2000),
  urgent       boolean not null default false,
  needs_confirm boolean not null default false,
  channels     text[] not null default '{push}',
  created_at   timestamptz not null default now()
);
create table station_broadcast_recipients (
  message_id   uuid not null references station_broadcasts(id),
  user_id      uuid not null references users(id),
  read_at      timestamptz,
  confirmed_at timestamptz,
  primary key (message_id, user_id)
);
