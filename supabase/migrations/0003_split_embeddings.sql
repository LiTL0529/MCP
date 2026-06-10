-- ============================================================
-- Migrate from ONE merged embedding to THREE per-field vectors
-- (title / summary / attributes). Run this on a database that was
-- created by the original 0001+0002. Idempotent. Fresh installs get
-- this layout directly from the updated 0001+0002 / setup_all.sql.
--
-- After running this, re-embed existing rows:   npm run backfill -- --all
-- ============================================================

-- 1) New per-field vector + input columns
alter table ja_insights
  add column if not exists title_embedding      vector(1536),
  add column if not exists summary_embedding    vector(1536),
  add column if not exists attributes_embedding vector(1536),
  add column if not exists title_emb_input      text,
  add column if not exists summary_emb_input    text,
  add column if not exists attributes_emb_input text;

-- 2) Per-field HNSW indexes
create index if not exists ja_insights_title_emb_idx   on ja_insights using hnsw (title_embedding vector_cosine_ops);
create index if not exists ja_insights_summary_emb_idx on ja_insights using hnsw (summary_embedding vector_cosine_ops);
create index if not exists ja_insights_attrs_emb_idx   on ja_insights using hnsw (attributes_embedding vector_cosine_ops);

-- 3) Drop the old match function FIRST (it references the old `embedding`
--    column, so the column drop below would otherwise fail).
drop function if exists ja_match_insights(vector, text[], boolean, integer, text, text, date, date, double precision);

-- 4) Drop the old single-vector artifacts
drop index if exists ja_insights_embedding_idx;
alter table ja_insights drop column if exists embedding;
alter table ja_insights drop column if exists embedding_input;

-- 5) Create the new per-field match function
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
  similarity              float,
  matched_field           text
)
language sql stable as $$
  with scored as (
    select i.*,
      case when i.title_embedding      is not null then 1 - (i.title_embedding      <=> query_embedding) end as s_title,
      case when i.summary_embedding    is not null then 1 - (i.summary_embedding    <=> query_embedding) end as s_summary,
      case when i.attributes_embedding is not null then 1 - (i.attributes_embedding <=> query_embedding) end as s_attrs
    from ja_insights i
    where ja_can_access(i.access, p_groups, p_is_admin)
      and (p_category  is null or i.category = p_category)
      and (p_status    is null or i.status   = p_status)
      and (p_date_from is null or i.report_date >= p_date_from)
      and (p_date_to   is null or i.report_date <= p_date_to)
      and (i.title_embedding is not null or i.summary_embedding is not null or i.attributes_embedding is not null)
  ),
  ranked as (
    select *, greatest(coalesce(s_title, -1), coalesce(s_summary, -1), coalesce(s_attrs, -1)) as similarity
    from scored
  )
  select
    id, report_id, report_date, access, attributes,
    category, status, type, creator, clients, tracks,
    title_en, title_zh, summary_en, summary_zh,
    insight_en, insight_zh,
    recommendations_en, recommendations_zh,
    sources, recommended_services_en, recommended_services_zh,
    similarity,
    case
      when similarity = coalesce(s_title, -1)   then 'title'
      when similarity = coalesce(s_summary, -1) then 'summary'
      else 'attributes'
    end as matched_field
  from ranked
  where similarity >= min_similarity
  order by similarity desc
  limit greatest(match_count, 1);
$$;
