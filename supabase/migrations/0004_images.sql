-- ============================================================
-- Add image vectorisation to insights.
--   * `images`           jsonb  — [{url, alt, caption, description}]
--   * `image_embedding`  vector — ONE vector for the article's images,
--                                 built by embedding the vision-model
--                                 descriptions (same 1536-d space as the
--                                 title/summary/attributes vectors), so a
--                                 plain text query can match images too.
--   * `image_emb_input`  text   — the exact description text embedded.
-- Run on a DB created by 0001+0002(+0003). Idempotent. Fresh installs get
-- this layout directly from setup_all.sql.
--
-- A public Storage bucket holds the uploaded image files; the server uploads
-- with the service role and stores the public URL in `images[].url`.
-- ============================================================

-- 1) New columns + ANN index
alter table ja_insights
  add column if not exists images           jsonb not null default '[]'::jsonb,
  add column if not exists image_embedding  vector(1536),
  add column if not exists image_emb_input  text;

create index if not exists ja_insights_image_emb_idx
  on ja_insights using hnsw (image_embedding vector_cosine_ops);

-- 2) Public bucket for uploaded insight images (service-role uploads, public read)
insert into storage.buckets (id, name, public)
values ('ja-insight-images', 'ja-insight-images', true)
on conflict (id) do nothing;

-- 3) Recreate the retrieval RPCs so they (a) score the image vector as a 4th
--    field in the max(), and (b) return the `images` jsonb. Return-type changes
--    require DROP first.
drop function if exists ja_match_insights(vector, text[], boolean, integer, text, text, date, date, double precision);
drop function if exists ja_list_insights(text[], boolean, text, text, date, date, integer, integer);
drop function if exists ja_get_insight(uuid, text[], boolean);

-- ── Semantic search (title / summary / attributes / image, max of four) ──────
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
