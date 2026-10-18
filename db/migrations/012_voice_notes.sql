-- Voice notes on tips, public issues and live reports (Rewards doc: "photos or a voice note").
alter table media drop constraint media_kind_check;
alter table media add constraint media_kind_check check (kind in ('photo', 'video', 'voice'));
alter table media drop constraint media_content_type_check;
alter table media add constraint media_content_type_check check (content_type in (
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg'));
-- Seconds, from the recorder; shown next to the player.
alter table media add column duration_s integer check (duration_s is null or duration_s between 0 and 600);
