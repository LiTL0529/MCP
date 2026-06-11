-- ============================================================
-- Read-only SQL access for the `run_sql` MCP tool.
--
-- This lets a connecting agent run its OWN cross-table JOIN / aggregation
-- queries — WITHOUT trusting the agent or its SQL for access control. The
-- security boundary lives entirely in the database:
--
--   1) a dedicated, low-privilege role `ja_reader`
--        • SELECT on the non-embedding columns of the queryable tables only,
--        • default_transaction_read_only = on  → it can never write,
--        • NOT the service role and NOT a table owner → RLS applies to it;
--   2) Row-Level Security on every queryable table, whose policy reuses the
--      same `ja_can_access(access, groups, is_admin)` predicate as the *_insights
--      RPCs. The caller's (groups, is_admin) arrive per-transaction via the GUCs
--      `ja.groups` / `ja.is_admin`, which the Node layer sets from the
--      authenticated API key (never from tool args / the SQL itself).
--
-- Net effect: even `select * from ja_insights` (no access filter at all) returns
-- only the rows the caller may see, and any JOIN inherits the same filtering.
--
-- The existing service-role read path (the ja_* RPCs) is UNAFFECTED: the service
-- role has BYPASSRLS in Supabase, so enabling RLS here does not change it.
--
-- ⚠ Before running: confirm nothing reads `ja_insights` directly as the `anon` or
--   `authenticated` roles. This app reads via the service role only, so enabling
--   RLS is safe; if you added other direct readers, give them their own policy.
-- Idempotent — safe to re-run.
-- ============================================================

-- ── 1) The restricted read-only role ───────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ja_reader') then
    -- LOGIN so a dedicated connection string can use it. Set its password
    -- OUT OF BAND (keep it in a secret, not in this file):
    --     alter role ja_reader with password '<strong-random>';
    -- then put the full DSN in SUPABASE_READONLY_URL.
    create role ja_reader login;
  end if;
end
$$;

-- Belt-and-suspenders: every transaction this role opens is read-only, and any
-- runaway query is killed. The Node layer also sets these per-transaction.
alter role ja_reader set default_transaction_read_only = on;
alter role ja_reader set statement_timeout = '5s';
alter role ja_reader set idle_in_transaction_session_timeout = '10s';

-- It needs to reach the schema and evaluate the policy predicate.
grant usage on schema public to ja_reader;
grant execute on function ja_can_access(text[], text[], boolean) to ja_reader;

-- ── 2) Column-level SELECT (no embeddings, no internal columns) ──
-- Granting specific columns keeps the heavy vector columns and bookkeeping
-- fields out of reach. NOTE: this means `select *` errors — the skill tells the
-- agent to list columns explicitly.
grant select (
  id, report_id, report_date, access, attributes,
  category, status, type, creator, clients, tracks,
  title_en, title_zh, summary_en, summary_zh,
  insight_en, insight_zh, recommendations_en, recommendations_zh,
  sources, recommended_services_en, recommended_services_zh,
  images, created_at, updated_at
) on ja_insights to ja_reader;

-- ── 3) Row-Level Security: the actual access boundary ──────
alter table ja_insights enable row level security;

-- Scoped `to ja_reader` so no other role's behaviour changes. The GUCs default
-- to "deny" when unset: missing ja.groups → NULL → only access='default' rows.
drop policy if exists ja_insights_sql_read on ja_insights;
create policy ja_insights_sql_read on ja_insights
  for select
  to ja_reader
  using (
    ja_can_access(
      access,
      string_to_array(nullif(current_setting('ja.groups', true), ''), ','),
      coalesce(nullif(current_setting('ja.is_admin', true), '')::boolean, false)
    )
  );

-- ============================================================
-- TEMPLATE — extend to each normalised table you add later
-- (e.g. ja_clients, ja_competitors, join tables). Repeat per table:
--
--   grant select (<non-sensitive columns>) on ja_clients to ja_reader;
--
--   -- Pure reference data visible to anyone who can see the joining insight:
--   --   leave RLS OFF and just grant select (above) — the JOIN to ja_insights
--   --   is already row-filtered, so unmatched rows never surface.
--   -- Self-sensitive data (its own access[] column): turn RLS ON and add a
--   --   policy mirroring the one above:
--   --
--   -- alter table ja_clients enable row level security;
--   -- create policy ja_clients_sql_read on ja_clients for select to ja_reader
--   --   using ( ja_can_access(access,
--   --     string_to_array(nullif(current_setting('ja.groups', true), ''), ','),
--   --     coalesce(nullif(current_setting('ja.is_admin', true), '')::boolean, false)) );
-- ============================================================
