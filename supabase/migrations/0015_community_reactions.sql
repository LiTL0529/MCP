-- 0015_community_reactions.sql — 点赞 / 收藏 for 需求社区 posts.
--
-- Two thin join tables keyed by (post_id, user_id). The PK guarantees one
-- like / one favorite per user per post (idempotent toggle). user_id is text
-- to match ja_community_posts.author_id (apikey/portal/oauth users may have a
-- non-uuid id). Counts are derived on read (count(*)) — no denormalized column,
-- so they can never drift. RLS deny-all; the Node app reads/writes with the
-- service role and stamps identity from the auth context (never the body).
-- Idempotent.

create table if not exists ja_community_likes (
  post_id    uuid not null references ja_community_posts(id) on delete cascade,
  user_id    text not null,
  user_email text,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists ja_community_favorites (
  post_id    uuid not null references ja_community_posts(id) on delete cascade,
  user_id    text not null,
  user_email text,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists idx_clikes_post on ja_community_likes(post_id);
create index if not exists idx_cfav_user   on ja_community_favorites(user_id, created_at desc);

alter table ja_community_likes     enable row level security;
alter table ja_community_favorites enable row level security;
