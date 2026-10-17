-- Percentage-of-recovered-value bounties, and payouts that complete through a Paystack transfer.

-- The value the agency recorded as recovered or seized, for "% of seized value" rates.
alter table tip_claims add column recovered_kobo bigint check (recovered_kobo is null or recovered_kobo > 0);

-- processing → paid | failed is driven by the signed transfer webhook.
alter table payouts
  add column paid_at        timestamptz,
  add column failure_reason text;

-- A rate's basis must carry what it needs: percent rates a percent and a cap.
alter table bounty_rates add constraint bounty_rates_percent_needs_cap
  check (basis <> 'percent_capped' or (cap_kobo is not null and (tiers ->> 'percent')::numeric > 0));
