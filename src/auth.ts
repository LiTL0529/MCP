import { createHash, randomBytes } from "node:crypto";
import { supabase } from "./supabase.js";
import { config } from "./config.js";
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
    seeAll: user.is_admin, // API-key users: admin sees all; others see their groups + default
    role: null,
    authVia: "apikey",
  };
}

/**
 * Resolve a browser request to its portal identity by delegating to the existing
 * FastAPI portal's `GET /api/me` with the forwarded session cookie
 * (`jh_access_token`, a Supabase Auth JWT). Both apps share one Supabase project,
 * so the portal is the single source of truth for who the user is and whether
 * they're an admin. Returns null if the cookie is missing or invalid.
 *
 * Visibility: any logged-in employee may read every insight; the `customer` role
 * is restricted to public (access=default) insights. Only admins may ingest.
 */
export async function resolvePortalUser(
  cookieHeader: string | undefined,
): Promise<UserContext | null> {
  if (!cookieHeader || cookieHeader.indexOf("jh_access_token") === -1) return null;
  try {
    const r = await fetch(`${config.portalApiBase}/api/me`, { headers: { cookie: cookieHeader } });
    if (!r.ok) return null;
    const me = (await r.json()) as {
      id?: string;
      email?: string;
      name?: string | null;
      role?: string | null;
      is_admin?: boolean;
    };
    if (!me || !me.email) return null;
    const role = me.role ?? null;
    return {
      userId: me.id ?? me.email,
      email: me.email,
      name: me.name ?? null,
      accessGroups: [],
      isAdmin: Boolean(me.is_admin),
      seeAll: role !== "customer", // employees see all; customers only access=default
      role,
      authVia: "portal",
    };
  } catch {
    return null;
  }
}
