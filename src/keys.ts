import { supabase } from "./supabase.js";
import { generateApiKey } from "./auth.js";

// ── Admin API-key management ───────────────────────────────
// Powers the admin backend's token panel: mint static `ja_` keys (shown once),
// list them, revoke immediately, or set/clear a future expiry. Uses the
// service-role client; the HTTP layer gates these to admins.

export interface CreateKeyInput {
  email: string;
  name?: string | null;
  groups?: string[];
  isAdmin?: boolean;
  label?: string | null;
  expiresAt?: string | null; // ISO timestamp, or null for no expiry
}

/**
 * Mint a new key for `email` (upserting the user, so groups/admin can be set in
 * the same step). The raw key is returned ONCE — only its hash is stored.
 */
export async function createApiKey(input: CreateKeyInput) {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("email is required");
  const groups = (input.groups ?? []).map((s) => s.trim()).filter(Boolean);

  const { data: user, error: userErr } = await supabase
    .from("ja_users")
    .upsert(
      { email, name: input.name ?? null, access_groups: groups, is_admin: Boolean(input.isAdmin) },
      { onConflict: "email" },
    )
    .select("id, email, name, access_groups, is_admin")
    .single();
  if (userErr || !user) throw new Error(`upsert user failed: ${userErr?.message}`);

  const { raw, hash, prefix } = generateApiKey();
  const { data: key, error: keyErr } = await supabase
    .from("ja_api_keys")
    .insert({
      user_id: user.id,
      key_hash: hash,
      key_prefix: prefix,
      // Raw key stored so the admin backend can re-copy it later (migration
      // 0011 — deliberate trade-off; only read via the admin-gated endpoint).
      key_plain: raw,
      label: input.label?.trim() || "admin-ui",
      expires_at: input.expiresAt ?? null,
    })
    .select("id, key_prefix, label, created_at, expires_at")
    .single();
  if (keyErr || !key) throw new Error(`insert key failed: ${keyErr?.message}`);

  return { raw, key, user };
}

/** List all keys with their owner + a computed status. Never returns the hash. */
export async function listApiKeys() {
  const { data, error } = await supabase
    .from("ja_api_keys")
    .select(
      "id, key_prefix, key_plain, label, created_at, last_used_at, revoked, expires_at, user:ja_users(email, name, is_admin, access_groups, is_active)",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listApiKeys failed: ${error.message}`);

  const now = Date.now();
  return (data ?? []).map((k: any) => {
    const u = Array.isArray(k.user) ? k.user[0] : k.user;
    const expired = k.expires_at ? new Date(k.expires_at).getTime() < now : false;
    return {
      id: k.id,
      key_prefix: k.key_prefix,
      key_plain: k.key_plain ?? null, // raw key if stored (0011+), else null (legacy)
      label: k.label,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      revoked: k.revoked,
      expires_at: k.expires_at,
      status: k.revoked ? "revoked" : expired ? "expired" : "active",
      email: u?.email ?? null,
      name: u?.name ?? null,
      is_admin: Boolean(u?.is_admin),
      access_groups: u?.access_groups ?? [],
    };
  });
}

/** Immediately kill a key (irreversible-ish — a new key must be minted). */
export async function revokeApiKey(id: string) {
  const { error } = await supabase.from("ja_api_keys").update({ revoked: true }).eq("id", id);
  if (error) throw new Error(`revokeApiKey failed: ${error.message}`);
}

/** Set or clear a key's expiry (pass null to make it non-expiring). */
export async function setKeyExpiry(id: string, expiresAt: string | null) {
  const { error } = await supabase.from("ja_api_keys").update({ expires_at: expiresAt }).eq("id", id);
  if (error) throw new Error(`setKeyExpiry failed: ${error.message}`);
}
