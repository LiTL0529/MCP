-- 0013_community.sql — 需求社区 (community): user posts + threaded comments.
--
-- Replaces the old static "需求意见箱": any authenticated user can post a thread
-- and comment on others'. Service-role only (RLS deny-all); the Node layer gates
-- writes to authenticated users and stamps identity from the auth context.
-- Idempotent.

create table if not exists ja_community_posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    text,                 -- portal id or ja_users id, as text (no FK)
  author_email text not null,
  author_name  text,
  title        text not null,
  body         text not null,
  pinned       boolean not null default false,   -- admins can pin
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ja_community_posts_created_idx on ja_community_posts (created_at desc);

create table if not exists ja_community_comments (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references ja_community_posts(id) on delete cascade,
  author_id    text,
  author_email text not null,
  author_name  text,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists ja_community_comments_post_idx on ja_community_comments (post_id, created_at);

alter table ja_community_posts    enable row level security;
alter table ja_community_comments enable row level security;
