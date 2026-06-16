-- 0016_user_state.sql — per-user key/value store for client app state.
--
-- Backs the insight-mark collections (⭐收藏 / ✅已使用 / 🎯促成销售) that used to
-- live only in localStorage, so they sync cross-device. Each row holds one
-- named JSON array for one user (keys: 'col' 实时洞察, 'cvcol' 创意洞察,
-- 'libcol' 月度洞察). The Node app reads/writes the whole array per key with
-- the service role and stamps user_id from the auth context. RLS deny-all.
-- user_id is text to match the other tables (apikey/portal/oauth ids). Idempotent.

create table if not exists ja_user_state (
  user_id    text not null,
  key        text not null,
  value      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table ja_user_state enable row level security;
