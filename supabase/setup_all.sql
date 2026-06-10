-- ============================================================
-- JA Insight Hub — ONE-PASTE SETUP
-- Paste this whole file into the Supabase SQL Editor and Run.
-- Idempotent: safe to run more than once.
-- ============================================================

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

  -- images: [{url, alt, caption, description}] — uploaded to Storage, the
  -- vision-model `description` is what gets embedded into image_embedding.
  images                   jsonb not null default '[]'::jsonb,

  -- vectorisation (English only) — ONE vector per field so each can be matched
  -- independently; at query time an article's score is max() across these four.
  title_embedding          vector(1536),
  summary_embedding        vector(1536),
  attributes_embedding     vector(1536),
  image_embedding          vector(1536),          -- embedding of the image descriptions
  title_emb_input          text,                  -- exact text embedded per field
  summary_emb_input        text,
  attributes_emb_input     text,
  image_emb_input          text,
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
create index if not exists ja_insights_image_emb_idx   on ja_insights using hnsw (image_embedding vector_cosine_ops);

-- Public bucket for uploaded insight images (service-role uploads, public read).
insert into storage.buckets (id, name, public)
values ('ja-insight-images', 'ja-insight-images', true)
on conflict (id) do nothing;

-- ============================================================
-- Access-control + retrieval RPCs (all prefixed ja_)
-- Each takes the caller's (groups, is_admin) and centralises the
-- visibility rule so the Node layer never re-implements it.
-- ============================================================

-- Visibility predicate, reused by every RPC below.
create or replace function ja_can_access(
  p_access   text[],
  p_groups   text[],
  p_is_admin boolean
) returns boolean
language sql immutable as $$
  select p_is_admin
      or 'default' = any(p_access)
      or coalesce(p_access && p_groups, false);
$$;

-- ── Semantic search ────────────────────────────────────────
-- Each article carries FOUR vectors (title / summary / attributes / image). We
-- score every field against the query independently, then the article's score
-- is the MAX of the four. One row per article (dedup is inherent), full body
-- returned, plus matched_field telling you which field drove the score.
drop function if exists ja_match_insights(vector, text[], boolean, integer, text, text, date, date, double precision);
create function ja_match_insights(
  query_embedding  vector(1536),
  p_groups         text[]  default '{}',
  p_is_admin       boolean default false,
  match_count      int     default 10,
  p_category       text    default null,
  p_status         text    default null,
  p_date_from      date    default null,
  p_date_to        date    default null,
  min_similarity   float   default 0.0
) returns table (
  id                      uuid,
  report_id               text,
  report_date             date,
  access                  text[],
  attributes              jsonb,
  category                text,
  status                  text,
  type                    text,
  creator                 text,
  clients                 text,
  tracks                  text,
  title_en                text,
  title_zh                text,
  summary_en              text,
  summary_zh              text,
  insight_en              text,
  insight_zh              text,
  recommendations_en      jsonb,
  recommendations_zh      jsonb,
  sources                 jsonb,
  recommended_services_en jsonb,
  recommended_services_zh jsonb,
  images                  jsonb,
  similarity              float,
  matched_field           text
)
language sql stable as $$
  with scored as (
    select i.*,
      case when i.title_embedding      is not null then 1 - (i.title_embedding      <=> query_embedding) end as s_title,
      case when i.summary_embedding    is not null then 1 - (i.summary_embedding    <=> query_embedding) end as s_summary,
      case when i.attributes_embedding is not null then 1 - (i.attributes_embedding <=> query_embedding) end as s_attrs,
      case when i.image_embedding      is not null then 1 - (i.image_embedding      <=> query_embedding) end as s_image
    from ja_insights i
    where ja_can_access(i.access, p_groups, p_is_admin)
      and (p_category  is null or i.category = p_category)
      and (p_status    is null or i.status   = p_status)
      and (p_date_from is null or i.report_date >= p_date_from)
      and (p_date_to   is null or i.report_date <= p_date_to)
      and (i.title_embedding is not null or i.summary_embedding is not null
        or i.attributes_embedding is not null or i.image_embedding is not null)
  ),
  ranked as (
    select *,
      greatest(coalesce(s_title, -1), coalesce(s_summary, -1),
               coalesce(s_attrs, -1), coalesce(s_image, -1)) as similarity
    from scored
  )
  select
    id, report_id, report_date, access, attributes,
    category, status, type, creator, clients, tracks,
    title_en, title_zh, summary_en, summary_zh,
    insight_en, insight_zh,
    recommendations_en, recommendations_zh,
    sources, recommended_services_en, recommended_services_zh,
    images,
    similarity,
    case
      when similarity = coalesce(s_title, -1)   then 'title'
      when similarity = coalesce(s_summary, -1) then 'summary'
      when similarity = coalesce(s_attrs, -1)   then 'attributes'
      else 'image'
    end as matched_field
  from ranked
  where similarity >= min_similarity
  order by similarity desc
  limit greatest(match_count, 1);
$$;

-- ── Browse / filter (non-semantic) ─────────────────────────
-- total_count is the full match size (window) for pagination.
drop function if exists ja_list_insights(text[], boolean, text, text, date, date, integer, integer);
create function ja_list_insights(
  p_groups    text[]  default '{}',
  p_is_admin  boolean default false,
  p_category  text    default null,
  p_status    text    default null,
  p_date_from date    default null,
  p_date_to   date    default null,
  p_limit     int     default 20,
  p_offset    int     default 0
) returns table (
  id          uuid,
  report_id   text,
  report_date date,
  access      text[],
  attributes  jsonb,
  category    text,
  status      text,
  type        text,
  clients     text,
  tracks      text,
  title_en    text,
  title_zh    text,
  summary_en  text,
  summary_zh  text,
  images      jsonb,
  total_count bigint
)
language sql stable as $$
  select
    i.id, i.report_id, i.report_date, i.access, i.attributes,
    i.category, i.status, i.type, i.clients, i.tracks,
    i.title_en, i.title_zh, i.summary_en, i.summary_zh,
    i.images,
    count(*) over() as total_count
  from ja_insights i
  where ja_can_access(i.access, p_groups, p_is_admin)
    and (p_category  is null or i.category = p_category)
    and (p_status    is null or i.status   = p_status)
    and (p_date_from is null or i.report_date >= p_date_from)
    and (p_date_to   is null or i.report_date <= p_date_to)
  order by i.report_date desc, i.report_id desc
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

-- ── Fetch one full report (access-checked) ─────────────────
-- Returns the full bilingual article, minus the embedding vector.
-- Zero rows => not found OR not permitted (caller can't distinguish).
drop function if exists ja_get_insight(uuid, text[], boolean);
create function ja_get_insight(
  p_id       uuid,
  p_groups   text[]  default '{}',
  p_is_admin boolean default false
) returns table (
  id                      uuid,
  report_id               text,
  report_date             date,
  access                  text[],
  attributes              jsonb,
  category                text,
  status                  text,
  type                    text,
  creator                 text,
  clients                 text,
  tracks                  text,
  title_en                text,
  title_zh                text,
  summary_en              text,
  summary_zh              text,
  insight_en              text,
  insight_zh              text,
  recommendations_en      jsonb,
  recommendations_zh      jsonb,
  sources                 jsonb,
  recommended_services_en jsonb,
  recommended_services_zh jsonb,
  images                  jsonb,
  created_at              timestamptz,
  updated_at              timestamptz
)
language sql stable as $$
  select
    i.id, i.report_id, i.report_date, i.access, i.attributes,
    i.category, i.status, i.type, i.creator, i.clients, i.tracks,
    i.title_en, i.title_zh, i.summary_en, i.summary_zh,
    i.insight_en, i.insight_zh,
    i.recommendations_en, i.recommendations_zh,
    i.sources, i.recommended_services_en, i.recommended_services_zh,
    i.images,
    i.created_at, i.updated_at
  from ja_insights i
  where i.id = p_id
    and ja_can_access(i.access, p_groups, p_is_admin);
$$;

-- ============================================================
-- Seed data — sample users + the example.md article.
-- The insight is inserted WITHOUT an embedding; run
--   npm run backfill
-- afterwards to vectorise it (needs OPENAI_API_KEY).
-- API keys are NOT seeded; mint them with `npm run create-key`.
-- ============================================================

insert into ja_users (email, name, access_groups, is_admin) values
  ('admin@jefferyasia.com', 'JA Admin',      '{}',    true),
  ('nus.user@nus.edu.sg',   'NUS Demo User', '{NUS}', false)
on conflict (email) do nothing;

insert into ja_insights (
  report_id, report_date, access, attributes,
  category, status, type, clients, tracks,
  title_en, title_zh, summary_en, summary_zh,
  insight_en, insight_zh,
  recommendations_en, recommendations_zh,
  sources, recommended_services_en, recommended_services_zh
) values (
  '02',
  '2026-05-25',
  '{NUS,SMU,NTU}',
  jsonb_build_object(
    'date', '2026-05-25',
    'access', to_jsonb(array['NUS','SMU','NTU']),
    'id', '02',
    'lang', 'en',
    'type', 'daily-insights',
    'category_zh', $ja$中国教育市场$ja$,
    'category_en', $ja$China Education Market$ja$,
    'status', 'RADAR',
    'clients_zh', $ja$NUS(新加坡国立大学), SMU(), NTU, INSEAD, SUSS_SUTD$ja$,
    'clients_en', $ja$NUS, SMU, NTU, INSEAD, SUSS, SUTD$ja$,
    'tracks_zh', $ja$新加坡硕士项目 / 商学院 EMBA 与 MBA / 政策与社科研究生项目 / 国际教育服务机构$ja$,
    'tracks_en', $ja$Master's Programs in Singapore / EMBA & MBA Programs at Business Schools / Postgraduate Programs in Policy Studies & Social Sciences / International Education Service Providers$ja$
  ),
  $ja$中国教育市场$ja$,
  'RADAR',
  'daily-insights',
  $ja$NUS, SMU, NTU, INSEAD, SUSS, SUTD$ja$,
  $ja$Master's Programs in Singapore / EMBA & MBA Programs at Business Schools / Postgraduate Programs in Policy Studies & Social Sciences / International Education Service Providers$ja$,
  $ja$Singapore Evolves into a Transit Hub for Chinese Enterprises Going Global: China's committed fixed asset investment in Singapore surged from 2.5% to roughly 21% within a year, making China the second-largest investment source. With proactive investment promotion by Singapore's EDB, ByteDance, Tencent and Alibaba having set up regional headquarters here, a new employment avenue has opened up for Chinese students pursuing studies in Singapore.$ja$,
  $ja$新加坡正把自己摆成中国企业出海的中转站：2025 年中国对新加坡的固定资产投资承诺一年内从 2.5% 跳到约 21%，跃居第二大来源。EDB 主动招商、字节腾讯阿里设区域总部，这给中国学生留学新加坡又多开了一条就业出口$ja$,
  $ja$According to the 2026 annual report released by Singapore's Economic Development Board (EDB), the national authority in charge of investment promotion, Singapore's total committed fixed asset investment across all industries stood at S$14.16 billion in 2025. Committed investment from Chinese enterprises reached approximately S$2.9 billion, accounting for around 21% of the total. This represented a sharp rise from 2.5% recorded in 2024, cementing China's position as Singapore's second-largest source of investment. (Source: SCMP citing EDB, May 3, 2026)$ja$,
  $ja$据新加坡经济发展局（EDB，新加坡国家级招商引资主管机构）2026 年 2 月发布的年度报告，2025 年新加坡全行业固定资产投资承诺总额 S$141.6 亿，中国企业承诺约 S$29 亿、占比约 21%，较 2024 年的 2.5% 大幅跳升，跃居第二大投资来源 [SCMP 引 EDB · 2026/05/03]$ja$,
  $ja$To put it simply, Singapore views Chinese enterprises as business partners and growth opportunities rather than potential risks. The EDB's active investment drive, matchmaking efforts by business chambers and Business China, coupled with a nearly tenfold jump in investment share within a year, reflect a clear national strategy. For partner universities in Singapore, the significance lies not just in macro trends, but in filling a long-standing gap in enrollment marketing content. Previously, Chinese students studying in Singapore were presented with two mainstream career paths: joining local Singaporean companies or returning to China for work. Now a distinct third path has emerged — working for Chinese enterprises operating in Singapore.$ja$,
  $ja$新加坡对中国企业市场环境的态度，用一句话概括就是把中国企业当客户、当机会，而不是当风险：EDB 招手、总商会和通商中国搭桥、投资份额一年涨近十倍，这是一个国家级的明确选择。对 JA 高校客户来说，这件事的价值不在宏观层面，而在它给招生内容补上了一块一直缺的拼图。中国学生留学新加坡的就业出口，过去只讲留新本地企业和回国就业两条路，现在多了清晰的第三条：在新加坡的中国企业。$ja$,
  jsonb_build_array(
    $ja$Add Chinese enterprises based in Singapore as the third career pathway in employment-related content. Leverage official EDB statistics and alumni employment data to create long infographics for WeChat Official Accounts and Q&A posts for Xiaohongshu.$ja$,
    $ja$Leverage the trend of Chinese enterprises going global as a core selling point for EMBA and MBA programs at business schools, featuring alumni career experiences at overseas Chinese enterprises and real cross-border management cases.$ja$,
    $ja$Focus content on business trends and talent demands, and avoid macro geopolitical discussions. Cite only authoritative statistics from official bodies such as the EDB and Caixin, and use neutral expressions like "regional hub" and "talent corridor".$ja$
  ),
  jsonb_build_array(
    $ja$把在新中国企业做成就业出口内容的第三条路径。用 EDB 公开数据和项目自己的校友去向做支撑，做成微信公众号长图与小红书问答笔记。$ja$,
    $ja$商学院 EMBA 与 MBA 用中国企业出海做高管教育钩子。校友在出海企业担任的岗位、课程中与东南亚市场相关的模块、真实的跨境管理案例。$ja$,
    $ja$内容口径锁定商业与人才，不碰宏观与地缘。只引 EDB、财新等官方与权威统计，用区域枢纽、人才走廊这类中性表述。$ja$
  ),
  jsonb_build_array(
    jsonb_build_object('tier', 'E', 'title', $ja$SCMP: Singapore's safe-haven status draws more Chinese capital (May 3, 2026)$ja$, 'url', 'https://www.scmp.com/business/article/3352046/singapores-safe-haven-status-draws-more-chinese-capital-property-sector'),
    jsonb_build_object('tier', 'F', 'title', $ja$Caixin: China's fixed asset investment in Singapore jumps more than eightfold (February 10, 2026)$ja$, 'url', 'https://www.caixinglobal.com/2026-02-10/chinas-fixed-asset-investment-in-singapore-jumps-more-than-eightfold-102413373.html'),
    jsonb_build_object('tier', 'Industry', 'title', $ja$Indeed Singapore: Job openings at Chinese companies in Singapore$ja$, 'url', 'https://sg.indeed.com/q-china-company-jobs.html')
  ),
  jsonb_build_array(
    $ja$Audience Profiling & Decision-Making Modeling$ja$,
    $ja$WeChat Official Account & WeChat Channel Operation$ja$,
    $ja$Brand Content Asset Library Development$ja$
  ),
  jsonb_build_array(
    $ja$受众画像与决策建模$ja$,
    $ja$微信公众号 + 视频号运营$ja$,
    $ja$品牌内容资产库建设$ja$
  )
)
on conflict (report_date, report_id) do nothing;
