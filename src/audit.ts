import { supabase } from "./supabase.js";
import { config } from "./config.js";
import type { UserContext } from "./types.js";

// ── Audit log of the agent ⇄ server tool-call conversation ─────────────────
// Every write is best-effort and fire-and-forget: a logging failure must never
// affect (or delay) the tool's response. Uses the service-role client, which
// bypasses RLS, so it can write the deny-by-default audit tables.

// Compact fields we lift from a tool's JSON result into `result_meta` so the log
// is queryable without storing whole article bodies.
const SUMMARY_KEYS = [
  "found", "count", "total", "row_count", "truncated",
  "top_similarity", "min_similarity", "group_by", "bucket_count", "reason",
] as const;

function summariseResult(res: any): { ok: boolean; meta: Record<string, unknown> | null; excerpt: string | null; full: unknown | null } {
  const ok = !res?.isError;
  const text = res?.content?.[0]?.text;
  if (typeof text !== "string") return { ok, meta: null, excerpt: null, full: null };

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON payload (e.g. an errorResult string) — keep a short excerpt.
    return { ok, meta: null, excerpt: text.slice(0, 1000), full: null };
  }
  const meta: Record<string, unknown> = {};
  for (const k of SUMMARY_KEYS) if (parsed && typeof parsed === "object" && k in parsed) meta[k] = parsed[k];
  return {
    ok,
    meta: Object.keys(meta).length ? meta : null,
    excerpt: null,
    full: config.auditStoreResults === "full" ? parsed : null,
  };
}

export interface ToolCallEntry {
  user: UserContext;
  sessionId?: string;
  tool: string;
  args: unknown;
  /** The MCP result envelope returned by the tool (omit when it threw). */
  result?: unknown;
  /** Set when the handler threw (as opposed to returning an error envelope). */
  error?: string | null;
  latencyMs: number;
}

/** Persist one tool call. Never throws, never blocks the caller. */
export function recordToolCall(e: ToolCallEntry): void {
  if (!config.auditEnabled) return;

  const summ = e.result !== undefined
    ? summariseResult(e.result)
    : { ok: false, meta: null, excerpt: null, full: null };
  const ok = e.error ? false : summ.ok;

  const row = {
    session_id: e.sessionId ?? null,
    user_id: e.user.userId,
    email: e.user.email,
    tool: e.tool,
    arguments: (e.args as Record<string, unknown>) ?? {},
    ok,
    error: e.error ?? (ok ? null : summ.excerpt),
    latency_ms: Math.max(0, Math.round(e.latencyMs)),
    result_meta: summ.meta,
    result: summ.full,
  };

  void supabase
    .from("ja_tool_calls")
    .insert(row)
    .then(({ error }) => {
      if (error) console.error(`audit: tool_call insert failed: ${error.message}`);
    });
}

// ── Read path (admin only) ─────────────────────────────────────────────────
export interface AuditQuery {
  tool?: string | null;
  email?: string | null;
  sessionId?: string | null;
  errorsOnly?: boolean | null; // true => only failed calls
  dateFrom?: string | null;    // ISO timestamp or YYYY-MM-DD (inclusive)
  dateTo?: string | null;      // ISO timestamp or YYYY-MM-DD (inclusive day)
  limit?: number;
  offset?: number;
}

/**
 * Read the tool-call audit trail. Uses the service-role client (which bypasses
 * the deny-by-default RLS on these tables), so the CALLER's admin-ness must be
 * checked by the tool/endpoint before invoking this. Returns lean columns (no
 * full `result` payload) plus an exact total for paging.
 */
export async function queryToolCalls(q: AuditQuery) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);

  let query = supabase
    .from("ja_tool_calls")
    .select(
      "id, created_at, session_id, email, tool, arguments, ok, error, latency_ms, result_meta",
      { count: "exact" },
    );

  if (q.tool) query = query.eq("tool", q.tool);
  if (q.email) query = query.eq("email", q.email);
  if (q.sessionId) query = query.eq("session_id", q.sessionId);
  if (q.errorsOnly === true) query = query.eq("ok", false);
  if (q.dateFrom) query = query.gte("created_at", q.dateFrom);
  if (q.dateTo) {
    // Pad a bare date to end-of-day so the whole day is included.
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.dateTo) ? `${q.dateTo}T23:59:59.999Z` : q.dateTo;
    query = query.lte("created_at", to);
  }

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`queryToolCalls failed: ${error.message}`);
  return { total: count ?? 0, limit, offset, items: data ?? [] };
}

/** Upsert the session row on connect (and refresh last_seen_at). Best-effort. */
export function recordSession(
  user: UserContext,
  sessionId: string,
  client?: { name?: string; version?: string },
): void {
  if (!config.auditEnabled) return;

  const row = {
    session_id: sessionId,
    user_id: user.userId,
    email: user.email,
    client_name: client?.name ?? null,
    client_version: client?.version ?? null,
    last_seen_at: new Date().toISOString(),
  };

  // onConflict updates only the columns we pass — started_at keeps its original
  // value, last_seen_at is refreshed.
  void supabase
    .from("ja_mcp_sessions")
    .upsert(row, { onConflict: "session_id" })
    .then(({ error }) => {
      if (error) console.error(`audit: session upsert failed: ${error.message}`);
    });
}
