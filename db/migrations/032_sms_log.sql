-- Every text message the platform sends, for support and delivery problems. Codes are blanked out
-- before saving; the provider's message id links to its own delivery report.
create table sms_log (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  provider_id  text,
  phone        text not null,
  body         text not null,
  urgent       boolean not null,
  state        text not null check (state in ('sent', 'failed')),
  error        text,
  attempts     smallint not null default 1,
  created_at   timestamptz not null default now()
);
create index on sms_log (phone, created_at desc);
create index on sms_log (created_at desc) where state = 'failed';
