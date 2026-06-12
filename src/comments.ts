import { supabase } from "./supabase.js";
import { getInsight } from "./insights.js";
import type { UserContext } from "./types.js";

// ── User comments on insight articles ──────────────────────
// Writes are open to any authenticated caller (subject to article access);
// reads are admin-only. The service-role client reaches the deny-by-default
// ja_insight_comments table (migration 0009); access control lives here.

/**
 * Add a comment to an insight the caller can access. Returns the new row, or
 * `null` if the insight doesn't exist OR the caller isn't allowed to see it
 * (the access check reuses the access-controlled get_insight RPC, so a user can
 * only comment on what they could already read).
 */
export async function addComment(user: UserContext, insightId: string, body: string) {
  const insight = await getInsight(user, insightId, "en");
  if (!insight) return null; // not found OR not permitted — caller can't tell

  const row = {
    insight_id: insightId,
    // author_id is plain text; only API-key users map to a ja_users id, but we
    // store whatever id we have for traceability and identify by email.
    author_id: user.userId ?? null,
    author_email: user.email,
    author_name: user.name,
    author_via: user.authVia,
    body,
  };
  const { data, error } = await supabase
    .from("ja_insight_comments")
    .insert(row)
    .select("id, insight_id, created_at")
    .single();
  if (error) throw new Error(`addComment failed: ${error.message}`);
  return data;
}

export interface CommentQuery {
  insightId?: string | null;
  email?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Read the comments (admin only — the caller's admin-ness MUST be checked before
 * invoking, since the service-role client bypasses RLS). Newest-first, with the
 * commented-on insight embedded for context, plus an exact `total` for paging.
 */
export async function listComments(q: CommentQuery) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);

  let query = supabase
    .from("ja_insight_comments")
    .select(
      "id, created_at, insight_id, author_email, author_name, author_via, body, insight:ja_insights(report_id, report_date, title_en)",
      { count: "exact" },
    );

  if (q.insightId) query = query.eq("insight_id", q.insightId);
  if (q.email) query = query.eq("author_email", q.email);
  if (q.dateFrom) query = query.gte("created_at", q.dateFrom);
  if (q.dateTo) {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.dateTo) ? `${q.dateTo}T23:59:59.999Z` : q.dateTo;
    query = query.lte("created_at", to);
  }

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`listComments failed: ${error.message}`);
  return { total: count ?? 0, limit, offset, items: data ?? [] };
}
