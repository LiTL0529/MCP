import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── 需求意见箱 (suggestion inbox) ──────────────────────────
// Any authenticated user may submit a suggestion; identity is stamped from the
// auth context (never the body). Admins list/triage. Service-role client; the
// ja_suggestions table is RLS-restricted, so access is gated in the HTTP layer.

const STATUSES = ["unread", "adopted"] as const;
export type SuggestionStatus = (typeof STATUSES)[number];

export interface SuggestionListParams {
  status?: string | null; // "unread" | "adopted" | "all"/null
  limit?: number;
  offset?: number;
}

export async function createSuggestion(
  user: UserContext,
  category: string | null,
  body: string,
) {
  const { data, error } = await supabase
    .from("ja_suggestions")
    .insert({
      author_id: user.userId ?? null,
      author_email: user.email,
      author_name: user.name,
      category: category && category.trim() ? category.trim() : null,
      body,
    })
    .select("id, created_at")
    .single();
  if (error) throw new Error(`createSuggestion failed: ${error.message}`);
  return data;
}

export async function listSuggestions(p: SuggestionListParams) {
  const limit = Math.min(Math.max(p.limit ?? 100, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);
  let query = supabase
    .from("ja_suggestions")
    .select("id, author_email, author_name, category, body, status, created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  if (p.status && p.status !== "all") query = query.eq("status", p.status);
  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(`listSuggestions failed: ${error.message}`);
  // Total unread (for the inbox badge), independent of the current filter.
  const { count: unread, error: cErr } = await supabase
    .from("ja_suggestions")
    .select("id", { count: "exact", head: true })
    .eq("status", "unread");
  if (cErr) throw new Error(`listSuggestions count failed: ${cErr.message}`);
  return { total: count ?? 0, unread: unread ?? 0, limit, offset, items: data ?? [] };
}

export async function setSuggestionStatus(id: string, status: string): Promise<boolean> {
  if (!STATUSES.includes(status as SuggestionStatus)) throw new Error("invalid status");
  const { data, error } = await supabase
    .from("ja_suggestions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`setSuggestionStatus failed: ${error.message}`);
  return !!data;
}
