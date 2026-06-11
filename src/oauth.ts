import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { supabase } from "./supabase.js";
import { config } from "./config.js";
import { hashKey, resolvePortalUser, authenticatePassword } from "./auth.js";
import type { UserContext } from "./types.js";

// ── Public OAuth URLs ──────────────────────────────────────
// The server is reached publicly under a path prefix (default /ja) via the
// nginx reverse proxy, which strips the prefix before forwarding to Node. So
// the handlers live at Node-root paths (/authorize, /token, …) but every URL
// we ADVERTISE must include the public prefix. issuer === <base><mount>.
const base = config.publicBaseUrl.replace(/\/$/, "");
const mount = config.oauthMount === "/" ? "" : config.oauthMount.replace(/\/$/, "");
export const oauthUrls = {
  issuer: `${base}${mount}`,
  authorizationEndpoint: `${base}${mount}/authorize`,
  tokenEndpoint: `${base}${mount}/token`,
  registrationEndpoint: `${base}${mount}/register`,
  revocationEndpoint: `${base}${mount}/revoke`,
  // The protected resource (the MCP endpoint itself).
  resource: `${base}${mount}/mcp`,
  // RFC 9728 Protected Resource Metadata, path-aware form, served at the domain
  // root (the .well-known is inserted before the resource's path).
  resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${mount}/mcp`,
};

// ── Authorization Server / Protected Resource metadata ─────
export function authServerMetadata() {
  return {
    issuer: oauthUrls.issuer,
    authorization_endpoint: oauthUrls.authorizationEndpoint,
    token_endpoint: oauthUrls.tokenEndpoint,
    registration_endpoint: oauthUrls.registrationEndpoint,
    revocation_endpoint: oauthUrls.revocationEndpoint,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["insights"],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: oauthUrls.resource,
    authorization_servers: [oauthUrls.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["insights"],
    resource_name: "JA Insight Hub",
  };
}

// ── Helpers ────────────────────────────────────────────────
function mint(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

// The identity snapshot we persist with codes/tokens. Captured once at login;
// rebuilt into a UserContext (authVia "oauth") on every verified request.
type Subject = {
  userId: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  seeAll: boolean;
  role: string | null;
  accessGroups: string[];
};
function toSubject(u: UserContext): Subject {
  return {
    userId: u.userId,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    seeAll: u.seeAll,
    role: u.role ?? null,
    accessGroups: u.accessGroups ?? [],
  };
}
function subjectToUser(s: Subject): UserContext {
  return {
    userId: s.userId,
    email: s.email,
    name: s.name ?? null,
    accessGroups: s.accessGroups ?? [],
    isAdmin: Boolean(s.isAdmin),
    seeAll: Boolean(s.seeAll),
    role: s.role ?? null,
    authVia: "oauth",
  };
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The browser-facing login + consent page. It POSTs straight back to the same
// /authorize endpoint (the SDK handler accepts POST and re-parses the OAuth
// params from the body), with the user's credentials added. All original OAuth
// parameters are carried as hidden fields so the round-trip is stateless.
function renderLogin(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  opts: { error?: string } = {},
): string {
  const hidden: Record<string, string> = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  };
  if (params.scopes?.length) hidden.scope = params.scopes.join(" ");
  if (params.state) hidden.state = params.state;
  if (params.resource) hidden.resource = params.resource.href;
  const hiddenHtml = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  const appName = esc(client.client_name || "应用");
  const err = opts.error
    ? `<p class="err">${esc(opts.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · JA Insight Hub</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center; background: #f5f6f8; }
  .card { width: 340px; max-width: 90vw; background: #fff; border-radius: 14px;
          box-shadow: 0 8px 30px rgba(0,0,0,.08); padding: 28px 26px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin: 0 0 18px; }
  .sub b { color: #222; }
  label { display: block; font-size: 13px; color: #444; margin: 12px 0 4px; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box;
          padding: 10px 12px; border: 1px solid #d0d3d9; border-radius: 8px; font-size: 14px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
           background: #2563eb; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .err { color: #c0392b; font-size: 13px; background: #fdecea; padding: 8px 10px;
         border-radius: 8px; margin: 12px 0 0; }
  .foot { color: #999; font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <h1>登录 JA Insight Hub</h1>
    <p class="sub"><b>${appName}</b> 请求以你的身份访问洞察数据。请使用你的 portal 账号登录授权。</p>
    <form method="post">
      ${hiddenHtml}
      <label for="email">邮箱</label>
      <input id="email" type="email" name="email" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required>
      ${err}
      <button type="submit">登录并授权</button>
    </form>
    <p class="foot">仅授权该应用，不会泄露你的密码。</p>
  </div>
</body>
</html>`;
}

// ── Clients store (Dynamic Client Registration) ───────────
const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const { data } = await supabase
      .from("ja_oauth_clients")
      .select("metadata")
      .eq("client_id", clientId)
      .maybeSingle();
    if (!data) return undefined;
    return data.metadata as OAuthClientInformationFull;
  },
  async registerClient(client) {
    const full = client as OAuthClientInformationFull;
    await supabase.from("ja_oauth_clients").insert({
      client_id: full.client_id,
      client_secret: full.client_secret ?? null,
      client_secret_expires_at: full.client_secret_expires_at ?? null,
      client_id_issued_at: full.client_id_issued_at ?? null,
      client_name: full.client_name ?? null,
      redirect_uris: full.redirect_uris ?? [],
      grant_types: full.grant_types ?? null,
      response_types: full.response_types ?? null,
      scope: full.scope ?? null,
      token_endpoint_auth_method: full.token_endpoint_auth_method ?? "none",
      metadata: full,
    });
    return full;
  },
};

// ── Provider ───────────────────────────────────────────────
export const jaOAuthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  // Begins the auth flow. We get `res`; its `.req` carries cookies/body so we
  // can do single-sign-on from an existing portal session, or render a login
  // form when there's none. On success we mint a single-use code and redirect.
  async authorize(client, params, res: Response) {
    const req = res.req;
    // 1) Single sign-on: a logged-in portal session cookie (same parent domain).
    let user = await resolvePortalUser(req.headers?.cookie as string | undefined);

    // 2) Otherwise, the login form posts credentials back to this same endpoint.
    if (!user) {
      const body = (req.body ?? {}) as { email?: string; password?: string };
      if (body.email && body.password) {
        user = await authenticatePassword(body.email, body.password);
        if (!user) {
          res
            .status(401)
            .set("Content-Type", "text/html; charset=utf-8")
            .send(renderLogin(client, params, { error: "邮箱或密码错误，请重试。" }));
          return;
        }
      } else {
        res
          .status(200)
          .set("Content-Type", "text/html; charset=utf-8")
          .send(renderLogin(client, params));
        return;
      }
    }

    // 3) Authenticated — issue a single-use authorization code.
    const code = mint("ja_oac");
    await supabase.from("ja_oauth_codes").insert({
      code_hash: hashKey(code),
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.href ?? null,
      subject: toSubject(user),
      expires_at: iso(config.oauthCodeTtlSec * 1000),
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  },

  // Returns the PKCE challenge stored when the code was issued (the SDK token
  // handler verifies code_verifier against it).
  async challengeForAuthorizationCode(client, authorizationCode) {
    const { data } = await supabase
      .from("ja_oauth_codes")
      .select("client_id, code_challenge, consumed, expires_at")
      .eq("code_hash", hashKey(authorizationCode))
      .maybeSingle();
    if (!data || data.client_id !== client.client_id) throw new Error("invalid_grant: unknown code");
    if (data.consumed) throw new Error("invalid_grant: code already used");
    if (new Date(data.expires_at).getTime() < Date.now()) throw new Error("invalid_grant: code expired");
    return data.code_challenge as string;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri) {
    const { data } = await supabase
      .from("ja_oauth_codes")
      .select("client_id, redirect_uri, scopes, resource, subject, consumed, expires_at")
      .eq("code_hash", hashKey(authorizationCode))
      .maybeSingle();
    if (!data || data.client_id !== client.client_id) throw new Error("invalid_grant: unknown code");
    if (data.consumed) throw new Error("invalid_grant: code already used");
    if (new Date(data.expires_at).getTime() < Date.now()) throw new Error("invalid_grant: code expired");
    if (redirectUri && redirectUri !== data.redirect_uri) throw new Error("invalid_grant: redirect_uri mismatch");

    // Single-use: consume immediately.
    await supabase.from("ja_oauth_codes").update({ consumed: true }).eq("code_hash", hashKey(authorizationCode));

    return issueTokens(client.client_id, data.subject as Subject, data.scopes as string[], data.resource as string | null);
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const { data } = await supabase
      .from("ja_oauth_tokens")
      .select("id, client_id, subject, scopes, resource, revoked, refresh_expires_at")
      .eq("refresh_hash", hashKey(refreshToken))
      .maybeSingle();
    if (!data || data.client_id !== client.client_id || data.revoked) throw new Error("invalid_grant: unknown refresh token");
    if (data.refresh_expires_at && new Date(data.refresh_expires_at).getTime() < Date.now())
      throw new Error("invalid_grant: refresh token expired");

    // Rotate: revoke the old row, issue a fresh access+refresh pair.
    await supabase.from("ja_oauth_tokens").update({ revoked: true }).eq("id", data.id);
    const useScopes = scopes?.length ? scopes : (data.scopes as string[]);
    return issueTokens(client.client_id, data.subject as Subject, useScopes, data.resource as string | null);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const row = await lookupAccessToken(token);
    if (!row) throw new Error("invalid_token");
    return {
      token,
      clientId: row.client_id,
      scopes: (row.scopes as string[]) ?? [],
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { subject: row.subject },
    };
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const h = hashKey(request.token);
    // The token may be either an access or refresh token; revoke whichever matches.
    await supabase
      .from("ja_oauth_tokens")
      .update({ revoked: true })
      .eq("client_id", client.client_id)
      .or(`access_hash.eq.${h},refresh_hash.eq.${h}`);
  },
};

async function issueTokens(
  clientId: string,
  subject: Subject,
  scopes: string[],
  resource: string | null,
): Promise<OAuthTokens> {
  const accessToken = mint("ja_oat");
  const refreshToken = mint("ja_ort");
  await supabase.from("ja_oauth_tokens").insert({
    access_hash: hashKey(accessToken),
    refresh_hash: hashKey(refreshToken),
    client_id: clientId,
    subject,
    scopes: scopes ?? [],
    resource,
    expires_at: iso(config.oauthAccessTtlSec * 1000),
    refresh_expires_at: iso(config.oauthRefreshTtlSec * 1000),
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.oauthAccessTtlSec,
    refresh_token: refreshToken,
    scope: scopes?.length ? scopes.join(" ") : undefined,
  };
}

async function lookupAccessToken(token: string) {
  const { data } = await supabase
    .from("ja_oauth_tokens")
    .select("id, client_id, subject, scopes, resource, revoked, expires_at")
    .eq("access_hash", hashKey(token))
    .maybeSingle();
  if (!data || data.revoked) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  // last_used_at is best-effort.
  void supabase.from("ja_oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return data;
}

/**
 * Resolve a raw OAuth access token to its UserContext, or null if invalid /
 * expired / revoked. Used by the HTTP auth middleware alongside API keys.
 */
export async function resolveOAuthAccessToken(raw: string): Promise<UserContext | null> {
  if (!raw) return null;
  const row = await lookupAccessToken(raw.trim());
  if (!row) return null;
  return subjectToUser(row.subject as Subject);
}
