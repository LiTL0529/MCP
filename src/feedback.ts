import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── 月度洞察「我的反馈」 (per-user feedback on each monthly insight) ──
// One row per (user, insight_ref), upserted. Identity comes from the auth
// context. Service-role client; ja_insight_feedback is RLS-restricted.

function uid(user: UserContext): string {
  return user.userId || user.email;
}

export interface FeedbackInput {
  used?: boolean;
  ways?: string[];
  client_name?: string | null;
  reaction?: string | null;
  client_feedback?: string | null;
  tags?: string[];
  follow_up?: boolean;
  note?: string | null;
  reason?: string | null;
  suggest?: string | null;
  insight_title?: string | null;
  insight_category?: string | null;
}

export async function upsertFeedback(user: UserContext, insightRef: string, f: FeedbackInput) {
  const row = {
    user_id: uid(user),
    user_email: user.email,
    insight_ref: insightRef,
    insight_title: f.insight_title ?? null,
    insight_category: f.insight_category ?? null,
    used: !!f.used,
    ways: f.ways ?? [],
    client_name: f.client_name ?? null,
    reaction: f.reaction ?? null,
    client_feedback: f.client_feedback ?? null,
    tags: f.tags ?? [],
    follow_up: !!f.follow_up,
    note: f.note ?? null,
    reason: f.reason ?? null,
    suggest: f.suggest ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("ja_insight_feedback")
    .upsert(row, { onConflict: "user_id,insight_ref" })
    .select("id, insight_ref, updated_at")
    .single();
  if (error) throw new Error(`upsertFeedback failed: ${error.message}`);
  return data;
}

/** All of the current user's feedback (newest-edited first). */
export async function listMyFeedback(user: UserContext) {
  const { data, error } = await supabase
    .from("ja_insight_feedback")
    .select(
      "insight_ref, insight_title, insight_category, used, ways, client_name, reaction, client_feedback, tags, note, follow_up, reason, suggest, created_at, updated_at",
    )
    .eq("user_id", uid(user))
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listMyFeedback failed: ${error.message}`);
  return { items: data ?? [] };
}
