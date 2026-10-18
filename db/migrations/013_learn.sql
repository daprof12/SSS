-- Learn feed: short safety videos, articles and quizzes, reviewed before they go live
-- (boards: Learn feed, For you, General, Admin learn feed).

create table learn_posts (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 140),
  caption       text not null default '' check (char_length(caption) <= 300),
  body          text check (body is null or char_length(body) <= 8000),        -- articles
  quiz          jsonb,                                                          -- quizzes: [{q, options, answer, why}]
  format        text not null check (format in ('video', 'article', 'quiz')),
  topic         text not null,
  language      text not null default 'en' check (language in ('en', 'pcm', 'yo', 'ha', 'ig')),
  duration_s    integer check (duration_s is null or duration_s between 1 and 3600),  -- video length or reading time
  source_agency uuid references agencies(id),                                   -- null: the platform team
  audience_state text,                                                          -- null: everyone; else a state code (LA, FC…)
  state         text not null default 'draft' check (state in ('draft', 'in_review', 'live', 'removed')),
  created_by    uuid not null references users(id),
  submitted_by  uuid references users(id),
  reviewed_by   uuid references users(id),
  review_note   text,
  removed_reason text,
  published_at  timestamptz,
  view_count    integer not null default 0,
  like_count    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Reviewed by someone other than whoever sent it.
  check (state <> 'live' or (reviewed_by is not null and reviewed_by is distinct from submitted_by))
);
create index on learn_posts (state, published_at desc);
create index on learn_posts (topic) where state = 'live';

-- One row per person and post: like, save, not interested, how far they got.
create table learn_reactions (
  post_id        uuid not null references learn_posts(id),
  user_id        uuid not null references users(id),
  liked          boolean not null default false,
  saved          boolean not null default false,
  not_interested boolean not null default false,
  seen_at        timestamptz,
  watched_s      integer not null default 0,
  completed      boolean not null default false,
  quiz_score     integer,
  updated_at     timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index on learn_reactions (user_id) where saved;

create table learn_interests (
  user_id    uuid primary key references users(id),
  topics     text[] not null default '{}',
  languages  text[] not null default '{en}',
  updated_at timestamptz not null default now()
);

-- Videos and cover images for posts use the same media pipeline as reports.
alter table media drop constraint media_owner_type_check;
alter table media add constraint media_owner_type_check check (owner_type in ('tip', 'issue_case', 'incident', 'learn_post'));
