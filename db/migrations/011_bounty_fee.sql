-- Platform fee on each bounty (Rewards doc: "The platform takes a fee of [%] on each bounty").
-- Platform admins set a suggested fee and the range; each agency may choose its own within it.
-- The fee is charged to the agency's pool on top of the bounty; the tipper gets the full bounty.

create table platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into platform_settings (key, value) values ('bounty_fee', '{"suggestedBps": 1000, "minBps": 500, "maxBps": 2000}');

-- null: the agency uses the suggested fee.
alter table agencies add column bounty_fee_bps integer check (bounty_fee_bps between 0 and 5000);

-- What was charged, fixed at approval.
alter table tip_claims
  add column fee_bps  integer,
  add column fee_kobo bigint check (fee_kobo is null or fee_kobo >= 0);

-- Fee income is kept apart from the clearing wallet.
alter table wallets drop constraint wallets_owner_type_check;
alter table wallets add constraint wallets_owner_type_check check (owner_type in ('user', 'agency', 'station', 'platform', 'platform_fees', 'bounty_pool', 'rewards_pool'));
insert into wallets (owner_type, owner_id) values ('platform_fees', null);
