-- ============================================================
-- Audit log of the agent ⇄ MCP-server "conversation".
--
-- The server only ever observes TOOL CALLS (not the model's natural-language
-- turns), so the faithful record of the exchange is: who called which tool,
-- with what arguments, what came back, how long it took, and any error. For
-- this app the arguments ARE the conversational content — search_insights.query
-- is the user's question, run_sql.sql is the agent's query.
--
-- Written server-side with the service role (bypasses RLS). These tables are
-- deliberately NOT granted to `ja_reader` and NOT added to the run_sql
-- QUERYABLE_TABLES, so a connecting agent can never read the audit trail.
-- Idempotent — safe to re-run.
-- ============================================================

-- ── MCP sessions (one row per initialised connection) ──────
create table if not exists ja_mcp_sessions (
  session_id     text primary key,                 -- mcp-session-id
  user_id        uuid references ja_users(id) on delete set null,
  email          text,
  client_name    text,                             -- reported by the MCP client
  client_version text,
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists ja_mcp_sessions_user_idx on ja_mcp_sessions(user_id, started_at desc);

-- ── Tool calls (one row per invocation) ────────────────────
-- session_id is a plain column (NOT a FK) so a fast first call never races the
-- session insert. `arguments` is stored verbatim; `result_meta` holds a small
-- summary (found/count/row_count/…); `result` holds the full payload only when
-- AUDIT_STORE_RESULTS=full.
create table if not exists ja_tool_calls (
  id          uuid primary key default gen_random_uuid(),
  session_id  text,
  user_id     uuid references ja_users(id) on delete set null,
  email       text,
  tool        text not null,
  arguments   jsonb not null default '{}'::jsonb,
  ok          boolean not null default true,
  error       text,
  latency_ms  integer,
  result_meta jsonb,
  result      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists ja_tool_calls_user_idx    on ja_tool_calls(user_id, created_at desc);
create index if not exists ja_tool_calls_tool_idx    on ja_tool_calls(tool);
create index if not exists ja_tool_calls_created_idx on ja_tool_calls(created_at desc);
create index if not exists ja_tool_calls_session_idx on ja_tool_calls(session_id);

-- Deny-by-default for everyone except the service role (which bypasses RLS).
-- No policies are added, so the read-only `ja_reader` / anon / authenticated
-- roles cannot see the audit log at all.
alter table ja_mcp_sessions enable row level security;
alter table ja_tool_calls   enable row level security;
