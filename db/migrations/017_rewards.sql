-- Rewards for rated responses (PRD "Ratings and rewards"; SRS TRUST-5/6). The platform rewards
-- pool pays; each agency sets the amount and how it is split between the officers on a response.

create table reward_rules (
  agency_id      uuid primary key references agencies(id),
  five_star_kobo bigint not null check (five_star_kobo between 0 and 2500000),
  four_star_pct  integer not null default 50 check (four_star_pct between 0 and 100),
  split          text not null default 'lead_first' check (split in ('equal', 'lead_first')),
  active         boolean not null default true,
  updated_by     uuid references users(id),
  updated_at     timestamptz not null default now()
);

-- One decision per incident, paid or not, with the reason (audit and anti-gaming review).
create table reward_payments (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null unique references incidents(id),
  agency_id   uuid references agencies(id),
  stars       smallint not null,
  total_kobo  bigint not null default 0 check (total_kobo >= 0),
  state       text not null check (state in ('paid', 'skipped')),
  reason      text,                     -- why nothing was paid: low_rating, no_rule, pool_empty, reporter_is_staff, repeat_rater, daily_cap
  shares      jsonb not null default '[]',
  available_at timestamptz,
  created_at  timestamptz not null default now()
);
create index on reward_payments (agency_id, created_at desc);

-- The platform's rewards pool (funded from a share of subscriptions and fines, PRD).
insert into wallets (owner_type, owner_id) select 'rewards_pool', null where not exists (select 1 from wallets where owner_type = 'rewards_pool');
