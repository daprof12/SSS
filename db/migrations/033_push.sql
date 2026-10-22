-- Web push: each device (browser or installed app) a person turned alerts on for, and which
-- notifications have been pushed. Existing notifications count as done, so nothing old is sent.
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  label       text,
  failures    smallint not null default 0,
  last_ok_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index on push_subscriptions (user_id);
alter table notifications add column pushed_at timestamptz;
update notifications set pushed_at = sent_at;
create index notifications_to_push on notifications (sent_at) where pushed_at is null;
