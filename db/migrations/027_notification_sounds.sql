-- Notification sounds: each person picks a sound per kind of notification, a volume and vibration.
alter table users add column sounds jsonb not null default
  '{"dispatch": "siren", "safety": "alarm", "reports": "chime", "general": "soft", "volume": 80, "vibrate": true}';
create index if not exists notifications_user_sent on notifications (user_id, sent_at desc) where channel = 'in_app';
