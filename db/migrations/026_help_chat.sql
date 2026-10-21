-- Help chat: the assistant answers first; a person from the help team can take over at any time
-- ("human in the loop"). Each conversation can become a help ticket so nothing is lost.
create table help_conversations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  surface      text not null default 'citizen' check (surface in ('citizen', 'officer', 'staff')),
  state        text not null default 'bot' check (state in ('bot', 'waiting_human', 'human', 'closed')),
  handoff_reason text,
  ticket_id    uuid references support_tickets(id),
  assigned_to  uuid references users(id),
  rating       smallint check (rating between 1 and 5),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on help_conversations (user_id, updated_at desc);
create index on help_conversations (state, updated_at);
create trigger help_conversations_updated before update on help_conversations for each row execute function set_updated_at();

create table help_messages (
  id              bigserial primary key,
  conversation_id uuid not null references help_conversations(id),
  role            text not null check (role in ('user', 'bot', 'agent', 'note')),
  author_id       uuid references users(id),
  body            text not null check (char_length(body) between 1 and 8000),
  sources         jsonb not null default '[]',
  created_at      timestamptz not null default now()
);
create index on help_messages (conversation_id, id);

insert into ai_use_cases (code, name, tier, mode, check_pct, status, sort)
values ('help_chat', 'Help chat assistant', 'primary', 'Answers, hands to a person', 5, 'live', 9)
on conflict (code) do nothing;
