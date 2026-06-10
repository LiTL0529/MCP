-- ============================================================
-- JA Insight Hub — core schema
-- Bilingual insight reports + per-user access control + pgvector
-- All objects are prefixed `ja_` to coexist with other apps in the
-- same database (e.g. an existing `insights` / `customer_pages`).
-- ============================================================

create extension if not exists vector;     -- pgvector
create extension if not exists pgcrypto;    -- gen_random_uuid(), digest()

-- ── updated_at helper ──────────────────────────────────────
create or replace function ja_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Users ──────────────────────────────────────────────────
-- A user belongs to zero or more access groups (e.g. {NUS,SMU}).
-- An insight is visible to a user when:
--   * the user is an admin, OR
--   * the insight's access[] contains 'default' (public), OR
--   * the insight's access[] overlaps the user's access_groups.
create table if not exists ja_users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text,
  access_groups text[] not null default '{}',
  is_admin      boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── API keys ───────────────────────────────────────────────
-- Raw keys are shown to the operator exactly once at creation time;
-- only the SHA-256 hash is stored. key_prefix is the visible label
-- (first chars of the raw key) for identification in the admin UI.
create table if not exists ja_api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references ja_users(id) on delete cascade,
  key_hash     text not null unique,
  key_prefix   text not null,
  label        text,
  last_used_at timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists ja_api_keys_user_idx on ja_api_keys(user_id);

-- ── Insights ───────────────────────────────────────────────
-- Bilingual content (en/zh). Only the English title + key attributes
-- + summary are embedded (see embedding_input / embedding).
create table if not exists ja_insights (
  id                       uuid primary key default gen_random_uuid(),

  -- editorial identity
  report_id                text not null,         -- e.g. "02"
  report_date              date not null,

  -- access control: 'default' => public, otherwise must overlap a user's groups
  access                   text[] not null default '{default}',

  -- the full "key attributes" metadata block, stored verbatim as JSON
  attributes               jsonb not null default '{}'::jsonb,

  -- denormalised, queryable attributes (also present inside `attributes`)
  category                 text,
  status                   text,
  type                     text,
  creator                  text,
  clients                  text,
  tracks                   text,

  -- bilingual content
  title_en                 text not null,
  title_zh                 text,
  summary_en               text not null,
  summary_zh               text,
  insight_en               text,                  -- 洞察 / Key Insights
  insight_zh               text,
  recommendations_en       jsonb not null default '[]'::jsonb,  -- 建议 / Recommendations (array of strings)
  recommendations_zh       jsonb not null default '[]'::jsonb,
  sources                  jsonb not null default '[]'::jsonb,  -- [{tier,title,url}]
  recommended_services_en  jsonb not null default '[]'::jsonb,  -- 推荐服务
  recommended_services_zh  jsonb not null default '[]'::jsonb,

  -- vectorisation (English only) — ONE vector per field so each can be matched
  -- independently; at query time an article's score is max() across these three.
  title_embedding          vector(1536),
  summary_embedding        vector(1536),
  attributes_embedding     vector(1536),
  title_emb_input          text,                  -- exact text embedded per field
  summary_emb_input        text,
  attributes_emb_input     text,
  embedded_at              timestamptz,

  created_by               uuid references ja_users(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (report_date, report_id)
);

drop trigger if exists trg_ja_insights_updated on ja_insights;
create trigger trg_ja_insights_updated
  before update on ja_insights
  for each row execute function ja_set_updated_at();

-- access[] overlap / containment lookups
create index if not exists ja_insights_access_idx on ja_insights using gin (access);
-- date browsing
create index if not exists ja_insights_date_idx on ja_insights (report_date desc);
-- category filter
create index if not exists ja_insights_category_idx on ja_insights (category);

-- Per-field approximate nearest-neighbour indexes (cosine). HNSW => good
-- recall + speed. Safe to create empty.
create index if not exists ja_insights_title_emb_idx   on ja_insights using hnsw (title_embedding vector_cosine_ops);
create index if not exists ja_insights_summary_emb_idx on ja_insights using hnsw (summary_embedding vector_cosine_ops);
create index if not exists ja_insights_attrs_emb_idx   on ja_insights using hnsw (attributes_embedding vector_cosine_ops);
