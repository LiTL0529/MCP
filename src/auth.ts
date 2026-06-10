import { createHash, randomBytes } from "node:crypto";
import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Mint a new raw API key plus the values to persist. Raw is shown once. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `ja_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 12) };
}

/**
 * Resolve a raw API key to its user context, or null if invalid/revoked.
 * Updates last_used_at opportunistically (fire-and-forget).
 */
export async function resolveApiKey(raw: string): Promise<UserContext | null> {
  if (!raw) return null;
  const key_hash = hashKey(raw.trim());

  const { data, error } = await supabase
    .from("ja_api_keys")
    .select("id, revoked, user:ja_users(id, email, name, access_groups, is_admin, is_active)")
    .eq("key_hash", key_hash)
    .maybeSingle();

  if (error || !data || data.revoked) return null;

  // supabase-js types a joined relation as an array or object depending on the
  // FK shape; normalise to a single object.
  const user = (Array.isArray(data.user) ? data.user[0] : data.user) as
    | {
        id: string;
        email: string;
        name: string | null;
        access_groups: string[] | null;
        is_admin: boolean;
        is_active: boolean;
      }
    | undefined;

  if (!user || !user.is_active) return null;

  void supabase
    .from("ja_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {});

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    accessGroups: user.access_groups ?? [],
    isAdmin: user.is_admin,
  };
}
