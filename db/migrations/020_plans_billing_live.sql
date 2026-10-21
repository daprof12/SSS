-- Home plans (board "Subscription and payment"), install jobs, monthly billing with dunning (board
-- "Payment problem"), and live camera view with the owner-visible access log (B6).

-- The camera's stream from the video provider; null until installed (development has none: test feed).
alter table devices add column stream_url text;

alter table subscriptions
  add column card_last4 text,
  add column last_paid_at timestamptz;

alter table dunning_state
  add column amount_kobo bigint,
  add column arrangement_note text;

alter table install_jobs add column visit_window_note text;

-- Who looked at a camera: owners and members too, so "Who viewed my camera" is complete.
alter table camera_access_log add column via text not null default 'app' check (via in ('app', 'dashboard', 'incident'));
