-- Withdrawals (Rewards doc "Wallet"; States doc withdraw flow): a bank account in the verified
-- name, a PIN, a delay on the first one, and a Paystack transfer that can fail and refund.

-- The name the identity check returned; bank accounts must match it.
alter table kyc_verifications add column full_name text;

alter table bank_accounts
  add column bank_code_name text,          -- display name at the time it was added
  add column resolved_name  text,          -- account name the bank returned
  add column first_paid_at  timestamptz;   -- set when a withdrawal to it first arrives
create unique index bank_accounts_one_live on bank_accounts (owner_type, owner_id) where removed_at is null;

alter table withdrawals
  add column user_id        uuid references users(id),
  add column fee_kobo       bigint not null default 0 check (fee_kobo >= 0),
  add column failure_reason text,
  add column held_reason    text,
  add column submitted_at   timestamptz,
  add column arrived_at     timestamptz,
  add column failed_at      timestamptz;
create index on withdrawals (user_id, created_at desc);
create index on withdrawals (state, release_at) where state = 'held_first';
