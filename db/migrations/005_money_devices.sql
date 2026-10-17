-- Wallets, ledger, payments, subscriptions, agency billing, tips, devices, jobs, notifications.
-- All amounts are integer kobo.

create table wallets (
  id         uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('user', 'agency', 'station', 'platform', 'bounty_pool', 'rewards_pool')),
  owner_id   uuid,
  currency   text not null default 'NGN' check (currency = 'NGN'),
  status     text not null default 'active' check (status in ('active', 'frozen', 'limited', 'closed')),
  created_at timestamptz not null default now(),
  unique (owner_type, owner_id)
);

-- Append-only. A balance is the sum of entries; nothing else changes money.
create table wallet_ledger (
  id           bigserial primary key,
  wallet_id    uuid not null references wallets(id),
  type         text not null check (type in ('fund', 'bounty', 'reward', 'donation_in', 'donation_out', 'withdrawal', 'withdrawal_reversal', 'payment', 'fine', 'refund', 'transfer')),
  amount_kobo  bigint not null check (amount_kobo <> 0),
  available_at timestamptz not null default now(),   -- bounties and rewards are held [n] days
  reference    text not null,                        -- paystack ref, internal transfer id
  journal_id   uuid not null,                        -- entries of one movement share a journal and sum to zero
  memo         text,
  created_at   timestamptz not null default now(),
  unique (wallet_id, reference, type)
);
create index on wallet_ledger (wallet_id, created_at desc);
create index on wallet_ledger (journal_id);
create trigger wallet_ledger_immutable before update or delete on wallet_ledger for each row execute function forbid_change();

-- Double entry: every journal must balance when its transaction commits.
create or replace function check_journal_balanced() returns trigger language plpgsql as $$
begin
  if (select coalesce(sum(amount_kobo), 0) from wallet_ledger where journal_id = new.journal_id) <> 0 then
    raise exception 'journal % does not balance', new.journal_id using errcode = 'P0003';
  end if;
  return null;
end $$;
create constraint trigger wallet_ledger_balanced after insert on wallet_ledger
  deferrable initially deferred for each row execute function check_journal_balanced();

create view wallet_balances as
select w.id as wallet_id, w.owner_type, w.owner_id,
       coalesce(sum(l.amount_kobo) filter (where l.available_at <= now()), 0)::bigint as available_kobo,
       coalesce(sum(l.amount_kobo) filter (where l.available_at > now()), 0)::bigint as held_kobo
from wallets w left join wallet_ledger l on l.wallet_id = w.id
group by w.id;

-- The outside world: money that enters or leaves through Paystack is booked
-- against this wallet so internal journals still balance.
insert into wallets (owner_type, owner_id) values ('platform', null);

create table bank_accounts (
  id          uuid primary key default gen_random_uuid(),
  owner_type  text not null check (owner_type in ('user', 'agency')),
  owner_id    uuid not null,
  bank_code   text not null,
  bank_name   text not null,
  last_four   text not null check (last_four ~ '^[0-9]{4}$'),
  account_name text not null,
  name_match  boolean not null,
  recipient_code text,
  verified_at timestamptz,
  removed_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- Every Paystack webhook is stored once; reprocessing is a no-op.
create table webhook_events (
  provider    text not null,
  event_id    text not null,
  event_type  text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

create table payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id),
  agency_id     uuid references agencies(id),
  purpose       text not null check (purpose in ('wallet_fund', 'install', 'subscription', 'fine', 'donation', 'agency_invoice', 'bounty_pool')),
  purpose_ref   uuid,
  amount_kobo   bigint not null check (amount_kobo > 0),
  method        text check (method in ('card', 'bank_transfer', 'ussd', 'wallet', 'invoice')),
  provider_ref  text not null unique,
  idempotency_key text not null unique,
  state         text not null default 'initiated' check (state in ('initiated', 'pending', 'succeeded', 'failed', 'abandoned', 'refunded')),
  failure_reason text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (user_id is not null or agency_id is not null)
);
create trigger payments_updated before update on payments for each row execute function set_updated_at();

create table withdrawals (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id),
  bank_account_id uuid not null references bank_accounts(id),
  amount_kobo   bigint not null check (amount_kobo > 0),
  state         text not null default 'requested' check (state in ('requested', 'held_first', 'processing', 'sent', 'arrived', 'failed_refunded')),
  transfer_code text unique,
  idempotency_key text not null unique,
  release_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table donations (
  id          uuid primary key default gen_random_uuid(),
  donor_id    uuid not null references users(id),
  target_type text not null check (target_type in ('agency', 'station', 'officer')),
  target_id   uuid not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  show_name   boolean not null default false,
  payment_id  uuid references payments(id),
  created_at  timestamptz not null default now()
);

create table payout_shares (
  agency_id       uuid primary key references agencies(id),
  officer_pct     numeric(5, 2) not null,
  station_pct     numeric(5, 2) not null,
  agency_pct      numeric(5, 2) not null,
  check (officer_pct + station_pct + agency_pct = 100)
);

create table payouts (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references agencies(id),
  amount_kobo   bigint not null check (amount_kobo > 0),
  state         text not null default 'pending' check (state in ('pending', 'awaiting_second_approval', 'processing', 'paid', 'failed', 'held')),
  approved_by   uuid[] not null default '{}',
  hold_note     text,
  transfer_code text unique,
  created_at    timestamptz not null default now(),
  check (state <> 'held' or hold_note is not null)
);

-- Household plans and subscriptions. Billing starts at install (decided 2026-10-17).
create table plans (
  code            text primary key,
  audience        text not null check (audience in ('household', 'community', 'agency', 'agency_addon')),
  name            text not null,
  price_kobo      bigint not null check (price_kobo >= 0),
  install_fee_kobo bigint not null default 0,
  interval        text not null check (interval in ('month', 'year')),
  devices_included jsonb not null default '{}',
  active          boolean not null default true
);

create table subscriptions (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references users(id),
  property_id   uuid references properties(id),
  agency_id     uuid references agencies(id),
  plan_code     text not null references plans(code),
  state         text not null default 'draft' check (state in (
                  'draft', 'install_pending', 'install_booked', 'active', 'grace', 'extras_paused',
                  'sharing_paused', 'switched_off', 'paused', 'cancelled')),
  autopay_from_wallet boolean not null default false,
  paystack_code text,
  period_start  timestamptz,
  next_bill_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (owner_id is not null or agency_id is not null),
  check (state not in ('active', 'grace', 'extras_paused', 'sharing_paused', 'switched_off') or period_start is not null)
);
create trigger subscriptions_updated before update on subscriptions for each row execute function set_updated_at();

create table dunning_state (
  subscription_id uuid primary key references subscriptions(id),
  stage           text not null,
  due_since       date not null,
  next_action_at  timestamptz not null,
  attempts        smallint not null default 0,
  arrangement     text check (arrangement in ('payment_plan', 'pause'))
);

create table agency_fees (
  code       text primary key,
  label      text not null,
  amount_kobo bigint not null,
  cycle      text not null check (cycle in ('one_time', 'monthly', 'per_item_monthly', 'per_item_one_time', 'percent'))
);

create table invoices (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null references agencies(id),
  number      text not null unique,
  lines       jsonb not null,
  total_kobo  bigint not null,
  po_number   text,
  state       text not null default 'issued' check (state in ('draft', 'issued', 'paid', 'overdue', 'waived', 'credited')),
  due_on      date not null,
  created_at  timestamptz not null default now()
);

create table bounty_rates (
  agency_id uuid not null references agencies(id),
  category  text not null,
  basis     text not null check (basis in ('fixed', 'tiered', 'percent_capped')),
  tiers     jsonb not null default '{}',
  cap_kobo  bigint,
  active    boolean not null default true,
  primary key (agency_id, category)
);

create table tips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  category    text not null,
  agency_id   uuid references agencies(id),
  location_id uuid references locations(id),
  description text not null check (char_length(description) between 20 and 1000),
  anonymous   boolean not null default true,
  public_no   text not null unique,                  -- the only identity an agency sees by default
  state       text not null default 'sent' check (state in ('sent', 'in_queue', 'more_info', 'claim_review', 'approved_held', 'available', 'declined', 'closed_no_result', 'found_false')),
  linked_case uuid,
  created_at  timestamptz not null default now()
);

create table tip_claims (
  id               uuid primary key default gen_random_uuid(),
  tip_id           uuid not null unique references tips(id),   -- one claim per tip
  outcome          text not null,
  severity         text,
  suggested_kobo   bigint not null,
  approved_kobo    bigint,
  decided_by       uuid references users(id),
  decline_reason   text,
  created_at       timestamptz not null default now()
);

create table devices (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id),
  location_id uuid references locations(id),
  type        text not null check (type in ('camera', 'street_light', 'gateway', 'drone')),
  serial      text not null unique,
  status      text not null default 'offline' check (status in ('online', 'low_power', 'offline', 'needs_repair', 'tamper')),
  last_seen   timestamptz,
  cert_fingerprint text,
  created_at  timestamptz not null default now()
);

create table device_events (
  id         bigserial primary key,
  device_id  uuid not null references devices(id),
  kind       text not null,
  confidence numeric(4, 3),
  payload    jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index on device_events (device_id, at desc);

create table install_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('install', 'repair', 'collect')),
  property_id   uuid not null references properties(id),
  subscription_id uuid references subscriptions(id),
  technician_id uuid references technicians(user_id),
  state         text not null default 'unassigned' check (state in ('unassigned', 'scheduled', 'quote_pending', 'en_route', 'on_site', 'awaiting_devices', 'awaiting_customer_code', 'done', 'cancelled')),
  scheduled_at  timestamptz,
  customer_code_hash text,
  quote_kobo    bigint,
  created_at    timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  type       text not null,
  grp        text not null check (grp in ('safety', 'reports', 'money', 'account', 'tips', 'learn', 'marketing', 'dispatch', 'team')),
  channel    text not null check (channel in ('push', 'sms', 'email', 'in_app', 'whatsapp')),
  title      text not null,
  body       text not null,
  deep_link  text,
  sent_at    timestamptz not null default now(),
  read_at    timestamptz
);
create index on notifications (user_id, sent_at desc);

create table notification_prefs (
  user_id uuid not null references users(id),
  grp     text not null,
  channel text not null,
  enabled boolean not null,
  primary key (user_id, grp, channel),
  -- Safety, account and money messages cannot be switched off (States doc).
  check (enabled or grp not in ('safety', 'account', 'money', 'dispatch'))
);
