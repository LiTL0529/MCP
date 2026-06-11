-- ============================================================
-- Aggregation RPC (ja_aggregate_insights)
-- Answers "how many / breakdown / trend" questions by computing the
-- counts in Postgres instead of making the model enumerate and tally.
-- Same access filter + optional slice filters as the other RPCs.
-- p_group_by ∈ {category | status | type | month}; 'month' buckets by
-- report_date (YYYY-MM) and is ordered chronologically for trend lines.
-- ============================================================
create or replace function ja_aggregate_insights(
  p_groups    text[]  default '{}',
  p_is_admin  boolean default false,
  p_group_by  text    default 'category',
  p_category  text    default null,
  p_status    text    default null,
  p_date_from date    default null,
  p_date_to   date    default null
) returns table (
  bucket text,
  count  bigint
)
language sql stable as $$
  -- CTE so the outer ORDER BY can reference `bucket`/`count` as real columns;
  -- referencing an output alias inside a CASE expression in ORDER BY would fail.
  with agg as (
    select
      case p_group_by
        when 'status' then coalesce(i.status, '(none)')
        when 'type'   then coalesce(i.type,   '(none)')
        when 'month'  then to_char(i.report_date, 'YYYY-MM')
        else               coalesce(i.category, '(none)')
      end as bucket,
      count(*) as count
    from ja_insights i
    where ja_can_access(i.access, p_groups, p_is_admin)
      and (p_category  is null or i.category = p_category)
      and (p_status    is null or i.status   = p_status)
      and (p_date_from is null or i.report_date >= p_date_from)
      and (p_date_to   is null or i.report_date <= p_date_to)
    group by 1
  )
  select bucket, count
  from agg
  -- month → chronological (bucket asc); everything else → biggest bucket first.
  order by case when p_group_by = 'month' then bucket end asc nulls last,
           count desc,
           bucket asc;
$$;
