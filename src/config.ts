import "dotenv/config";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

// Outbound proxy (common in CN networks where api.openai.com needs a proxy).
// Honour the standard env vars; HTTPS_PROXY wins.
const proxyUrl =
  optional("HTTPS_PROXY") ||
  optional("https_proxy") ||
  optional("HTTP_PROXY") ||
  optional("http_proxy") ||
  optional("ALL_PROXY") ||
  undefined;

// Route Node's global fetch (used by @supabase/supabase-js) through the proxy.
// EnvHttpProxyAgent honours HTTP(S)_PROXY *and* NO_PROXY, so localhost (e.g. an
// MCP client hitting our own server) bypasses the proxy while api.openai.com /
// *.supabase.co go through it.
if (proxyUrl) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export const config = {
  proxyUrl,
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  openaiApiKey: required("OPENAI_API_KEY"),
  // Optional: point at an OpenAI-compatible endpoint (e.g. Alibaba DashScope
  // https://dashscope.aliyuncs.com/compatible-mode/v1). Empty => OpenAI default.
  openaiBaseUrl: optional("OPENAI_BASE_URL") || undefined,
  embeddingModel: optional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
  embeddingDim: Number(optional("EMBEDDING_DIM", "1536")),
  // Vision model used to describe uploaded images; the description is then
  // embedded with `embeddingModel` so images live in the same vector space as
  // text. Must be served by the same OPENAI_BASE_URL / OPENAI_API_KEY.
  visionModel: optional("OPENAI_VISION_MODEL", "gpt-4o-mini"),

  // Supabase Storage bucket that holds uploaded insight images (public read).
  storageBucket: optional("SUPABASE_STORAGE_BUCKET", "ja-insight-images"),
  // Public bucket for 需求社区 post attachments (md / html / pdf / …).
  filesBucket: optional("SUPABASE_FILES_BUCKET", "ja-community-files"),

  // Default minimum cosine similarity for semantic search. Matches below this
  // are dropped so weak/irrelevant results don't surface. Callers can still
  // override per query via `min_similarity` (pass 0 to disable). Tune to your
  // data — cross-lingual hits (zh query vs en embedding) tend to score lower.
  searchMinSimilarity: ((v: number) => (Number.isFinite(v) ? v : 0.2))(
    Number(optional("SEARCH_MIN_SIMILARITY", "0.2")),
  ),

  // Read-only Postgres DSN for the `run_sql` MCP tool, logging in as the
  // low-privilege `ja_reader` role (migration 0006). Empty => the SQL tool is
  // not registered. NEVER point this at the service role — that bypasses RLS.
  readonlyDatabaseUrl: optional("SUPABASE_READONLY_URL") || undefined,
  // run_sql guard rails: max rows returned and per-query timeout (ms).
  sqlMaxRows: ((v: number) => (Number.isFinite(v) && v > 0 ? v : 1000))(Number(optional("SQL_MAX_ROWS", "1000"))),
  sqlTimeoutMs: ((v: number) => (Number.isFinite(v) && v > 0 ? v : 5000))(Number(optional("SQL_TIMEOUT_MS", "5000"))),

  // Audit log of the agent ⇄ server tool-call conversation (tables in 0007).
  // AUDIT_LOG=off disables it entirely. AUDIT_STORE_RESULTS=full also persists
  // the full returned payload (bigger rows); default 'summary' keeps only meta.
  auditEnabled: optional("AUDIT_LOG", "on").toLowerCase() !== "off",
  auditStoreResults: (optional("AUDIT_STORE_RESULTS", "summary").toLowerCase() === "full"
    ? "full"
    : "summary") as "summary" | "full",

  // Existing portal (FastAPI) base URL. Browser users are identified by
  // delegating to the portal's GET /api/me with their forwarded session cookie
  // (jh_access_token). Same Supabase project, same box.
  portalApiBase: optional("PORTAL_API_BASE", "http://127.0.0.1:8100"),

  // ── MCP OAuth (Authorization Server) ─────────────────────
  // OAUTH_ENABLED=off disables the OAuth flow (clients then need a static API
  // key). When on, MCP clients can connect with just the server URL: they do
  // Dynamic Client Registration + PKCE, the user logs in once in the browser
  // with their portal account, and the client gets a bearer token.
  oauthEnabled: optional("OAUTH_ENABLED", "on").toLowerCase() !== "off",
  // Public origin the server is reached at (for the URLs we advertise in OAuth
  // metadata). No trailing slash.
  publicBaseUrl: optional("PUBLIC_BASE_URL", "https://insights.jefurryaxis.ai"),
  // Public path prefix the reverse proxy mounts the server under (it strips the
  // prefix before forwarding). "/" if the server is at the domain root.
  oauthMount: optional("OAUTH_PUBLIC_MOUNT", "/ja"),
  // Anon key used when authenticating email/password against Supabase Auth from
  // the OAuth login page. Falls back to the service-role key (server-side only)
  // if unset, which Supabase also accepts as the `apikey`.
  supabaseAnonKey: optional("SUPABASE_ANON_KEY") || undefined,
  // Token lifetimes (seconds): access ~1h, refresh ~30d, auth code ~5m.
  oauthAccessTtlSec: ((v: number) => (Number.isFinite(v) && v > 0 ? v : 3600))(Number(optional("OAUTH_ACCESS_TTL", "3600"))),
  oauthRefreshTtlSec: ((v: number) => (Number.isFinite(v) && v > 0 ? v : 2592000))(Number(optional("OAUTH_REFRESH_TTL", "2592000"))),
  oauthCodeTtlSec: ((v: number) => (Number.isFinite(v) && v > 0 ? v : 300))(Number(optional("OAUTH_CODE_TTL", "300"))),

  port: Number(optional("PORT", "8787")),
  ingestToken: optional("INGEST_TOKEN"),
  corsOrigins: optional("CORS_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export type AppConfig = typeof config;
