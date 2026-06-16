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
    .select("id, revoked, expires_at, scopes, user:ja_users(id, email, name, access_groups, is_admin, is_active)")
    .eq("key_hash", key_hash)
    .maybeSingle();

  if (error || !data || data.revoked) return null;
  // Time-based expiry (migration 0010): a past expires_at disables the key.
  if (data.expires_at && new Date(data.expires_at as string).getTime() < Date.now()) return null;

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
    scopes: ((data as { scopes?: string[] | null }).scopes) ?? [],
    authVia: "apikey",
  };
}

/**
 * Resolve a *target* user by email into a read-only UserContext for access
 * scoping — used by the public daily-insights API to render "what THIS user can
 * see". Looks up ja_users (the access-control registry); never trusts caller-
 * supplied access groups. Returns null if the user is unknown or deactivated.
 */
export async function resolveTargetUser(email: string): Promise<UserContext | null> {
  const e = (email || "").trim();
  if (!e) return null;
  const { data, error } = await supabase
    .from("ja_users")
    .select("id, email, name, access_groups, is_admin, is_active")
    .ilike("email", e) // case-insensitive exact match (no wildcards)
    .maybeSingle();
  if (error || !data || !data.is_active) return null;
  // Deliberately NON-escalating: the public read API only ever exposes a target
  // user's group + 'default' insights, never the admin "see everything" bypass.
  // Otherwise a query:daily service key could read ALL insights by naming an
  // admin's email. isAdmin/seeAll are forced false for this scoped view.
  return {
    userId: data.id as string,
    email: data.email as string,
    name: (data.name as string | null) ?? null,
    accessGroups: (data.access_groups as string[] | null) ?? [],
    isAdmin: false,
    seeAll: false,
    role: null,
    scopes: [],
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

/**
 * Authenticate an email/password against Supabase Auth (the same identity store
 * the portal uses), then resolve the resulting identity through the portal's
 * `GET /api/me` so role/is_admin are derived identically. Used by the OAuth
 * login page when the browser has no portal session cookie yet. Returns null on
 * bad credentials. The password is sent only server-side to Supabase Auth.
 */
export async function authenticatePassword(
  email: string,
  password: string,
): Promise<UserContext | null> {
  const apikey = config.supabaseAnonKey || config.supabaseServiceRoleKey;
  try {
    const r = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey, Authorization: `Bearer ${apikey}` },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { access_token?: string };
    if (!data?.access_token) return null;
    // Reuse the portal as the single source of truth for who this user is.
    return resolvePortalUser(`jh_access_token=${data.access_token}`);
  } catch {
    return null;
  }
}
