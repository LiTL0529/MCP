import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── Per-user app state (KV) ────────────────────────────────
// Backs the insight-mark collections that used to live in localStorage so they
// sync cross-device. Only a fixed allow-list of keys is accepted; each value is
// a JSON array stored verbatim. RLS deny-all; identity comes from the auth
// context, never the request body.

export const STATE_KEYS = ["col", "cvcol", "libcol"] as const;
const ALLOWED = new Set<string>(STATE_KEYS as readonly string[]);

function uid(user: UserContext): string {
  return user.userId || user.email;
}

/** Fetch the named state arrays for a user; missing keys default to []. */
export async function getUserState(user: UserContext, keys: string[]) {
  const ks = keys.filter((k) => ALLOWED.has(k));
  const out: Record<string, unknown> = {};
  for (const k of ks) out[k] = [];
  if (!ks.length) return out;
  const { data, error } = await supabase
    .from("ja_user_state")
    .select("key, value")
    .eq("user_id", uid(user))
    .in("key", ks);
  if (error) throw new Error(`getUserState failed: ${error.message}`);
  for (const row of data ?? []) out[(row as any).key] = (row as any).value;
  return out;
}

/** Upsert one named state array for a user. */
export async function setUserState(user: UserContext, key: string, value: unknown) {
  if (!ALLOWED.has(key)) throw new Error(`invalid state key: ${key}`);
  const { error } = await supabase
    .from("ja_user_state")
    .upsert(
      { user_id: uid(user), key, value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" },
    );
  if (error) throw new Error(`setUserState failed: ${error.message}`);
  return { ok: true };
}
