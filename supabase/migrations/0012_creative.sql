-- 0012_creative.sql — creative-insight (video decode) records.
--
-- The workbench's 创意洞察 section was frontend-only (localStorage mock). This
-- persists it: one row per creative video selection, with the summary fields the
-- list/analytics need as columns, plus a flexible `body` jsonb for the full
-- decode (methodology breakdown, AI路径, 适配客户 etc.). Access mirrors insights:
-- access[]='default' is public; otherwise it must overlap a viewer's groups.
--
-- Service-role only (RLS deny-all); the Node layer applies the access filter and
-- gates ingest to admins, exactly like ja_insights' RPC path. Idempotent.

create table if not exists ja_creative_insights (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  platform     text,                          -- 小红书 / 抖音 / 视频号 / B站 / YouTube / ...
  category     text,
  link         text,                          -- source video URL
  methods      jsonb not null default '[]'::jsonb,   -- methodology tags (string[])
  images       jsonb not null default '[]'::jsonb,   -- thumbnail / frame URLs (string[])
  body         jsonb not null default '{}'::jsonb,   -- full decode content (flexible)
  report_date  date not null default current_date,
  access       text[] not null default '{default}',
  created_by   uuid references ja_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ja_creative_date_idx     on ja_creative_insights (report_date desc);
create index if not exists ja_creative_category_idx  on ja_creative_insights (category);
create index if not exists ja_creative_access_idx     on ja_creative_insights using gin (access);

alter table ja_creative_insights enable row level security;
