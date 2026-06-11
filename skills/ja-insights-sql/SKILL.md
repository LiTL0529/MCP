---
name: ja-insights-sql
description: >-
  Query the JA Insight Hub with your own SQL via the run_sql MCP tool — for
  cross-table JOINs and aggregations that search_insights / list_insights /
  aggregate_insights can't express. Use when the user needs combined data
  across tables, multi-dimension filters, or custom GROUP BY / trend math.
---

# JA Insight Hub — ad-hoc SQL

The `run_sql` tool runs **one read-only SQL query** against the insight database
and returns `{ columns, rows, row_count, truncated }`.

## Access control — read this first

**Every query is automatically restricted to the rows your API key may see.**
The database injects your identity and filters with Row-Level Security, even
across JOINs.

- **Do NOT** add `access`, group, or tenant conditions yourself — they're applied
  for you, and you cannot bypass them.
- An empty result means *nothing you're allowed to see matched* — say so, don't
  guess. (A user with no groups sees only `access = 'default'` rows.)

So you decide **what** to query; the database decides **who sees what**.

## How to call it

Pass a single statement to `run_sql`:

- **SELECT or WITH only.** No `;`, no writes, no DDL — they're rejected/blocked.
- **List columns explicitly. Never `SELECT *`** — the embedding/vector columns
  aren't accessible and `*` will error.
- At most **1000 rows** come back (`truncated: true` means there were more —
  add `LIMIT`, filter harder, or aggregate). Queries **time out after 5s**.

## Schema

The authoritative, always-current schema is the MCP resource
**`schema://ja-insights`** — read it before writing a query rather than guessing
column names. (It's generated live from the database, so it never drifts.) If a
column name is wrong, `run_sql` returns a clear `column ... does not exist`
error — read the resource and retry.

## When to use which tool

| You want… | Use |
|---|---|
| The few **most relevant** insights to a phrase | `search_insights` (semantic) |
| **All** rows matching simple exact filters (category/status/date) | `list_insights` |
| A **count / breakdown / trend** on one field | `aggregate_insights` |
| **JOINs across tables, multi-dimension filters, custom GROUP BY** | `run_sql` |

Reach for `run_sql` only when the first three can't express the question.

## Examples

```sql
-- Monthly count of RADAR-status insights in a category
select to_char(report_date, 'YYYY-MM') as month, count(*) as n
from ja_insights
where status = 'RADAR' and category = '中国教育市场'
group by 1
order by 1;
```

```sql
-- Insights that cite a tier-E source, newest first
select id, report_date, title_en
from ja_insights, jsonb_array_elements(sources) as s
where s->>'tier' = 'E'
order by report_date desc
limit 50;
```

```sql
-- Distinct clients mentioned in the last 90 days, with how many insights each
select clients, count(*) as n
from ja_insights
where report_date >= current_date - interval '90 days'
  and clients is not null
group by clients
order by n desc;
```

> Once the schema is normalised into more tables (e.g. `ja_clients`,
> `ja_competitors` and join tables), JOIN them here directly — they're
> row-filtered the same way. Always read `schema://ja-insights` for the current
> set of queryable tables and columns.

## Reporting back

State whether anything was found (`row_count`), present the returned `rows`
(don't answer from your own knowledge), and if `truncated` is true tell the user
the result was capped so they can narrow it.
