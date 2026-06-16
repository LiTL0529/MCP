-- 需求意见箱 (suggestion inbox)
-- Lightweight ideas / feedback that any authenticated user submits and admins
-- triage (unread → adopted). Replaces the old static front-end SUGS mock.
-- Service-role only (RLS enabled, no policies); the Node layer gates access:
-- any logged-in user may POST; only admins may list / change status.

create table if not exists ja_suggestions (
  id           uuid primary key default gen_random_uuid(),
  author_id    text,                                       -- portal / ja_users id (text, no FK)
  author_email text,
  author_name  text,
  category     text,                                       -- 洞察选题建议 / 新栏目建议 / 平台优化 / 使用问题 / 其他
  body         text not null,
  status       text not null default 'unread',             -- unread | adopted
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists ja_suggestions_created_idx on ja_suggestions (created_at desc);
create index if not exists ja_suggestions_status_idx  on ja_suggestions (status);

alter table ja_suggestions enable row level security;

drop trigger if exists ja_suggestions_set_updated_at on ja_suggestions;
create trigger ja_suggestions_set_updated_at
  before update on ja_suggestions
  for each row execute function ja_set_updated_at();
