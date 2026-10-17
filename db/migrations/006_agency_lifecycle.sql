-- Agency onboarding and subscription lifecycle — UX Gap Analysis §10, stages 1–11.
-- Prices and day counts are placeholders held as config rows, not code.

-- 1 Register: application details, contact person, evidence strength.
alter table agencies
  add column legal_name        text,
  add column unit_type         text,
  add column official_email    citext,
  add column email_evidence    text check (email_evidence in ('government_domain', 'other_domain')),
  add column tin               text,
  add column signatory_name    text,
  add column contact_user_id   uuid references users(id),
  add column review_comment    text,                -- shown on "More information needed"
  add column decision_reason   text,                -- shown on "Rejected"
  add column submitted_at      timestamptz,
  add column decided_at        timestamptz,
  add column live_at           timestamptz,
  add column period_start      date,                -- current billing period [period_start, period_end)
  add column period_end        date,
  add column offboard_reason   text,
  add column offboarded_at     timestamptz,
  -- Billing starts once the onboarding fee is paid (the API sets both); agencies without a period are not billed.
  add check ((period_start is null) = (period_end is null) and (period_start is null or period_end > period_start));

-- 2 Documents: metadata only, storage is behind an adapter. Replacing a file supersedes the old row.
alter table agency_documents
  add column file_name     text,
  add column content_type  text,
  add column size_bytes    integer check (size_bytes > 0 and size_bytes <= 20 * 1024 * 1024),
  add column uploaded_by   uuid references users(id),
  add column superseded_at timestamptz,
  add check (kind in ('establishment_proof', 'authorisation_letter', 'head_id', 'signatory_letter', 'registration_certificate'));
create unique index agency_documents_current on agency_documents (agency_id, kind) where superseded_at is null;

-- Timeline for the status page (Submitted → In review → Decision). Append-only.
create table agency_events (
  id         bigserial primary key,
  agency_id  uuid not null references agencies(id),
  event      text not null,
  from_state text,
  to_state   text not null,
  actor_id   uuid references users(id),
  comment    text,
  at         timestamptz not null default now()
);
create index on agency_events (agency_id, id);
create trigger agency_events_immutable before update or delete on agency_events for each row execute function forbid_change();

-- 4 Choose plan: fee schedule rows (config) for the agency audience.
alter table plans add column includes jsonb not null default '{}';
insert into plans (code, audience, name, price_kobo, interval, includes) values
  ('agency_base',          'agency',       'Base: dashboard and routing', 25000000, 'month', '{"stations": 3}'),
  ('addon_extra_station',  'agency_addon', 'Extra station',                5000000, 'month', '{"stations": 1}'),
  ('addon_drone_fire',     'agency_addon', 'Drone and fire drop programme', 40000000, 'month', '{}'),
  ('addon_messaging',      'agency_addon', 'Messaging credits (1,000)',    3500000, 'month', '{"messages": 1000}')
on conflict (code) do nothing;

insert into agency_fees (code, label, amount_kobo, cycle) values
  ('onboarding',          'Onboarding and document check', 50000000, 'one_time'),
  ('station_overage',     'Station over plan allowance',    7500000, 'per_item_monthly'),
  ('inventory_drone_kit', 'Drone kit',                      2000000, 'per_item_monthly'),
  ('inventory_vehicle',   'Vehicle tracker',                 500000, 'per_item_monthly'),
  ('inventory_radio',     'Radio',                           150000, 'per_item_monthly'),
  ('messaging_sms',       'SMS message',                        400, 'per_item_monthly'),
  ('messaging_whatsapp',  'WhatsApp message',                   250, 'per_item_monthly')
on conflict (code) do nothing;

-- Per-agency override for pilot partners (admin Settings → Plans). Every change is audited.
create table agency_price_overrides (
  agency_id   uuid not null references agencies(id),
  code        text not null,
  amount_kobo bigint not null check (amount_kobo >= 0),
  reason      text not null,
  set_by      uuid not null references users(id),
  created_at  timestamptz not null default now(),
  primary key (agency_id, code)
);

-- The agency's selection. A row covers [starts_on, ends_on); a change closes the old row
-- (now for upgrades, at period end for downgrades) and opens a new one.
create table agency_plan_items (
  id         uuid primary key default gen_random_uuid(),
  agency_id  uuid not null references agencies(id),
  code       text not null references plans(code),
  quantity   integer not null check (quantity > 0),
  starts_on  date not null,
  ends_on    date,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on > starts_on)
);
create index on agency_plan_items (agency_id, starts_on);
create or replace function agency_plan_items_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from plans where code = new.code and audience in ('agency', 'agency_addon')) then
    raise exception '% is not an agency plan or add-on', new.code using errcode = 'P0004';
  end if;
  if exists (select 1 from agency_plan_items i where i.agency_id = new.agency_id and i.code = new.code and i.id <> new.id
               and daterange(i.starts_on, i.ends_on) && daterange(new.starts_on, new.ends_on)) then
    raise exception '% overlaps an existing selection for this agency', new.code using errcode = 'P0004';
  end if;
  return new;
end $$;
create trigger agency_plan_items_valid before insert or update on agency_plan_items for each row execute function agency_plan_items_check();

-- 5/8 Invoices: onboarding, monthly and proration, with PO number, VAT and reminders.
alter table invoices
  add column kind           text not null default 'monthly' check (kind in ('onboarding', 'monthly', 'proration')),
  add column period_start   date,
  add column period_end     date,
  add column subtotal_kobo  bigint not null default 0,
  add column vat_kobo       bigint not null default 0,
  add column pay_by_invoice boolean not null default false,  -- "Pay by invoice": proforma + PO + dedicated account
  add column transfer_account jsonb,                         -- the dedicated account shown on the proforma
  add column reminders_sent text[] not null default '{}',
  add column paid_at        timestamptz,
  add column waive_reason   text,
  add column waive_approvals uuid[] not null default '{}',
  add column decided_at     timestamptz,
  add column updated_at     timestamptz not null default now(),
  add check (total_kobo = subtotal_kobo + vat_kobo),
  add check (state <> 'waived' or waive_reason is not null),
  add check (state <> 'paid' or paid_at is not null);
create trigger invoices_updated before update on invoices for each row execute function set_updated_at();
-- One monthly invoice per agency and period, so the generator can rerun safely.
create unique index invoices_one_per_period on invoices (agency_id, period_start) where kind = 'monthly';
create unique index invoices_one_onboarding on invoices (agency_id) where kind = 'onboarding';
create sequence invoice_number_seq;

-- Money received against an invoice: matched Paystack payments, or bank transfers
-- that finance marks as received when unmatched. Append-only.
create table invoice_payments (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id),
  amount_kobo   bigint not null check (amount_kobo > 0),
  method        text not null check (method in ('paystack', 'bank_transfer_marked')),
  payment_id    uuid references payments(id),
  bank_reference text,
  received_on   date not null default current_date,
  marked_by     uuid references users(id),
  note          text,
  created_at    timestamptz not null default now(),
  check (method <> 'paystack' or payment_id is not null),
  check (method <> 'bank_transfer_marked' or (marked_by is not null and bank_reference is not null))
);
create index on invoice_payments (invoice_id);
create unique index invoice_payments_once_per_payment on invoice_payments (payment_id) where payment_id is not null;
create unique index invoice_payments_once_per_bank_ref on invoice_payments (bank_reference) where bank_reference is not null;
create trigger invoice_payments_immutable before update or delete on invoice_payments for each row execute function forbid_change();

-- Inventory the agency is billed for (drone kits, vehicles, radios). Adding is held while overdue.
create table agency_inventory (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null references agencies(id),
  station_id  uuid references stations(id),
  fee_code    text not null references agency_fees(code),
  quantity    integer not null check (quantity > 0),
  added_by    uuid references users(id),
  created_at  timestamptz not null default now(),
  removed_at  timestamptz
);

-- Messaging usage (SMS / WhatsApp) billed monthly beyond the credits add-on.
create table agency_usage (
  id         bigserial primary key,
  agency_id  uuid not null references agencies(id),
  fee_code   text not null references agency_fees(code),
  units      integer not null check (units > 0),
  at         timestamptz not null default now()
);
create index on agency_usage (agency_id, at);

-- Second approver for payouts above the threshold: who requested and why.
alter table payouts
  add column reason       text,
  add column requested_by uuid references users(id),
  add column decided_at   timestamptz,
  add column source_wallet_id uuid references wallets(id);   -- set when paying out a wallet balance (bounty pool at offboarding)

-- 6 Set up — the single checklist, computed from the real tables so it can't drift:
-- 1 stations and heads → 2 areas and routing → 3 officers verified → 4 payout account → 5 bounty pool (optional).
create or replace function agency_setup_checklist(p_agency uuid, p_min_verified integer default 1)
returns table (step smallint, code text, required boolean, done boolean, detail jsonb)
language sql stable as $$
  with st as (
    select s.id, s.name, s.head_user_id,
           exists (select 1 from station_areas a where a.station_id = s.id) as has_area,
           (select count(*) from officers o where o.station_id = s.id and o.badge_status = 'verified') as verified
      from stations s where s.agency_id = p_agency and s.status <> 'paused'
  ),
  bank as (
    select b.name_match, b.verified_at from bank_accounts b
     where b.owner_type = 'agency' and b.owner_id = p_agency and b.removed_at is null
     order by b.created_at desc limit 1
  ),
  pool as (
    select coalesce(sum(wb.available_kobo), 0)::bigint as kobo from wallets w join wallet_balances wb on wb.wallet_id = w.id
     where w.owner_type = 'bounty_pool' and w.owner_id = p_agency
  )
  select 1::smallint, 'stations_and_heads', true,
         (select count(*) > 0 and bool_and(head_user_id is not null) from st),
         jsonb_build_object('stations', (select count(*) from st), 'withoutHead', (select coalesce(jsonb_agg(name), '[]') from st where head_user_id is null))
  union all
  select 2::smallint, 'areas_and_routing', true,
         (select count(*) > 0 and bool_and(has_area) from st),
         jsonb_build_object('withoutArea', (select coalesce(jsonb_agg(name), '[]') from st where not has_area))
  union all
  select 3::smallint, 'officers_verified', true,
         (select count(*) > 0 and bool_and(verified >= p_min_verified) from st),
         jsonb_build_object('minPerStation', p_min_verified, 'short', (select coalesce(jsonb_agg(name), '[]') from st where verified < p_min_verified))
  union all
  select 4::smallint, 'payout_account', true,
         coalesce((select name_match and verified_at is not null from bank), false)
           and (select paystack_subaccount is not null from agencies where id = p_agency),
         jsonb_build_object('linked', exists (select 1 from bank), 'nameMatches', (select name_match from bank))
  union all
  -- Optional; required only to accept tips with bounties.
  select 5::smallint, 'bounty_pool', false,
         exists (select 1 from bounty_rates where agency_id = p_agency and active) and (select kobo from pool) > 0,
         jsonb_build_object('rates', (select count(*) from bounty_rates where agency_id = p_agency and active), 'poolKobo', (select kobo from pool))
  order by 1
$$;
