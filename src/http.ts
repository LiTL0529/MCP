import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { z } from "zod";
import { config } from "./config.js";
import { resolveApiKey, resolvePortalUser, resolveTargetUser } from "./auth.js";
import {
  jaOAuthProvider,
  resolveOAuthAccessToken,
  authServerMetadata,
  protectedResourceMetadata,
  oauthUrls,
} from "./oauth.js";
import { queryToolCalls, recordSession } from "./audit.js";
import { buildMcpServer } from "./mcp.js";
import { createInsight, getDailyCards, getDailyInsights, getInsight, listInsights, searchInsights } from "./insights.js";
import { createApiKey, deleteApiKey, listApiKeys, revokeApiKey, setKeyExpiry } from "./keys.js";
import { createCreative, getCreative, listCreative } from "./creative.js";
import { getOverviewStats } from "./stats.js";
import { addPostComment, createPost, deletePost, getPost, listFavorites, listLikes, listPosts, toggleFavorite, toggleLike, updatePost } from "./community.js";
import { createSuggestion, listSuggestions, setSuggestionStatus } from "./suggestions.js";
import { getUserState, setUserState, STATE_KEYS } from "./state.js";
import { getInsightCategories, setSetting } from "./settings.js";
import { uploadFile } from "./storage.js";
import { parseBilingualMd } from "./markdown.js";
import type { Lang, UserContext } from "./types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserContext;
    }
  }
}

// Anchored to the project root so it works under both tsx (src/) and tsc (dist/).
const publicDir = path.join(process.cwd(), "public");

function bearer(req: Request): string | null {
  const h = req.header("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Normalise an expiry input to an ISO string or null. A bare date (YYYY-MM-DD)
// is taken as end-of-day UTC so the key stays valid through that whole day;
// anything else is treated as an ISO timestamp. Empty/unparseable => null.
function normaliseExpiry(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59.999Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Auth middleware (MCP read path) ────────────────────────
async function resolveCaller(req: Request): Promise<UserContext | null> {
  // Agents/scripts present a Bearer token — either a static API key or an OAuth
  // access token. Browser users present a portal session cookie.
  const raw = bearer(req);
  let user = raw ? await resolveApiKey(raw) : null;
  if (!user && raw && config.oauthEnabled) user = await resolveOAuthAccessToken(raw);
  if (!user) user = await resolvePortalUser(req.header("cookie"));
  return user;
}

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await resolveCaller(req);
  if (!user) {
    // Point OAuth-capable clients at our protected-resource metadata so they can
    // discover the authorization server and start the login flow (RFC 9728).
    if (config.oauthEnabled) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${oauthUrls.resourceMetadataUrl}"`);
    }
    res.status(401).json({ error: "未登录或登录已失效（请先登录 portal，或提供有效 API key / OAuth 令牌）" });
    return;
  }
  req.user = user;
  next();
}

// ── Auth for the ingest endpoint ───────────────────────────
// Accepts EITHER an admin API key (Bearer) OR the shared INGEST_TOKEN header.
async function requireIngestAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("x-ingest-token");
  if (config.ingestToken && token && token === config.ingestToken) {
    next();
    return;
  }
  // Otherwise require an authenticated ADMIN — a portal admin (cookie), an admin
  // API key, or an admin OAuth token. Only admins may ingest insights.
  const user = await resolveCaller(req);
  if (user?.isAdmin) {
    req.user = user;
    next();
    return;
  }
  res.status(403).json({ error: "仅管理员可录入洞察" });
}

// Lightweight in-memory fixed-window rate limiter for the public API. Single
// process (systemd node), so a Map is sufficient; keyed by the caller's user id
// (service account). Defence-in-depth against bulk extraction / runaway loops.
const DAILY_API_LIMIT = 120; // requests per window per key-owner
const DAILY_API_WINDOW_MS = 60_000;
const dailyApiHits = new Map<string, { count: number; resetAt: number }>();
function dailyApiRateOk(ownerId: string, now: number): boolean {
  const e = dailyApiHits.get(ownerId);
  if (!e || now >= e.resetAt) {
    dailyApiHits.set(ownerId, { count: 1, resetAt: now + DAILY_API_WINDOW_MS });
    return true;
  }
  if (e.count >= DAILY_API_LIMIT) return false;
  e.count++;
  return true;
}

// API-key-ONLY auth for the public daily-insights API (server-to-server). The
// key must be an admin key OR carry the `query:daily` scope. Portal-cookie
// callers are intentionally NOT accepted here.
async function requireDailyApi(req: Request, res: Response, next: NextFunction) {
  const raw = bearer(req);
  const user = raw ? await resolveApiKey(raw) : null;
  if (!user) {
    res.status(401).json({ error: "需要有效的 API Key（Authorization: Bearer ja_...）" });
    return;
  }
  if (!user.isAdmin && !(user.scopes ?? []).includes("query:daily")) {
    res.status(403).json({ error: "此 API Key 无权调用（需要 query:daily 权限或管理员 Key）" });
    return;
  }
  if (!dailyApiRateOk(user.userId, Date.now())) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: `请求过于频繁（每分钟上限 ${DAILY_API_LIMIT} 次），请稍后再试` });
    return;
  }
  req.user = user;
  next();
}

// ── Ingest payload schema ──────────────────────────────────
const sourceSchema = z.object({
  tier: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
});

// An image either carries base64 `data` (uploaded to Storage server-side) or a
// pre-hosted `url`. At least one is required.
const imageSchema = z
  .object({
    data: z.string().optional(),
    url: z.string().optional(),
    alt: z.string().nullish(),
    caption: z.string().nullish(),
  })
  .refine((v) => Boolean(v.data?.trim() || v.url?.trim()), {
    message: "each image needs either 'data' (base64) or 'url'",
  });

const createSchema = z.object({
  report_id: z.string().min(1),
  report_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "report_date must be YYYY-MM-DD"),
  access: z.array(z.string()).optional(),
  attributes: z.record(z.any()).optional(),
  category: z.string().nullish(),
  status: z.string().nullish(),
  type: z.string().nullish(),
  creator: z.string().nullish(),
  clients: z.string().nullish(),
  tracks: z.string().nullish(),
  title_en: z.string().min(1),
  title_zh: z.string().nullish(),
  summary_en: z.string().min(1),
  summary_zh: z.string().nullish(),
  insight_en: z.string().nullish(),
  insight_zh: z.string().nullish(),
  recommendations_en: z.array(z.string()).optional(),
  recommendations_zh: z.array(z.string()).optional(),
  sources: z.array(sourceSchema).optional(),
  recommended_services_en: z.array(z.string()).optional(),
  recommended_services_zh: z.array(z.string()).optional(),
  images: z.array(imageSchema).optional(),
});

export function buildApp() {
  const app = express();
  // Large limit so base64-encoded image uploads fit in the ingest payload.
  app.use(express.json({ limit: "25mb" }));

  // Minimal CORS for the submit form (only if origins are configured).
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && config.corsOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Ingest-Token");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "ja-insight-hub", time: new Date().toISOString() }));

  // ── OAuth 2.1 Authorization Server + discovery metadata ───
  // MCP clients (Claude Code, Claude.ai, …) connect with just the server URL:
  // they discover this AS from the 401 WWW-Authenticate header, register
  // dynamically, run the PKCE auth-code flow, and the user logs in once with
  // their portal account. The reverse proxy strips the public path prefix
  // (/ja), so the handlers live here at root paths.
  if (config.oauthEnabled) {
    // Discovery documents must be readable cross-origin (web MCP clients).
    const serveMeta = (body: object) => (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    };
    // RFC 8414 (AS metadata) and RFC 9728 (protected-resource metadata). We
    // answer both the root and the path-aware forms a client may probe — the
    // proxy routes the domain-root .well-known/* here, and forwards /ja/* with
    // the prefix stripped, so all variants land on these handlers.
    const asMeta = serveMeta(authServerMetadata());
    const prMeta = serveMeta(protectedResourceMetadata());
    const mountTail = config.oauthMount === "/" ? "" : config.oauthMount.replace(/\/$/, "");
    app.options(/\/\.well-known\/oauth-.*/, (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.sendStatus(204);
    });
    app.get("/.well-known/oauth-authorization-server", asMeta);
    if (mountTail) app.get(`/.well-known/oauth-authorization-server${mountTail}`, asMeta);
    app.get("/.well-known/oauth-protected-resource", prMeta);
    app.get(`/.well-known/oauth-protected-resource${mountTail}/mcp`, prMeta);

    // Flow endpoints. The SDK handlers parse params, enforce PKCE, and call our
    // provider. They each install their own body parser + CORS.
    app.use("/authorize", authorizationHandler({ provider: jaOAuthProvider }));
    app.use("/token", tokenHandler({ provider: jaOAuthProvider }));
    app.use("/register", clientRegistrationHandler({ clientsStore: jaOAuthProvider.clientsStore }));
    app.use("/revoke", revocationHandler({ provider: jaOAuthProvider }));
  }

  // ── MCP (Streamable HTTP, stateful sessions) ─────────────
  // Each session is bound to the user that initialised it. We still
  // authenticate every request so a revoked key stops working at once,
  // and we reject requests whose key doesn't own the session.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; userId: string }>();

  app.post("/mcp", requireUser, async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown session" }, id: null });
          return;
        }
        if (entry.userId !== req.user!.userId) {
          res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Session belongs to another key" }, id: null });
          return;
        }
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      // No session yet — the first message must be `initialize`.
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No active session — send an 'initialize' request first" },
          id: null,
        });
        return;
      }

      const user = req.user!;
      const server = buildMcpServer(user);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, userId: user.userId });
          // Record the session for the audit trail; client name/version is known
          // once initialize has been processed.
          let client: { name?: string; version?: string } | undefined;
          try {
            client = server.server.getClientVersion();
          } catch {
            client = undefined;
          }
          recordSession(user, sid, client);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        void server.close();
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
      }
    }
  });

  // GET (server→client SSE stream) and DELETE (terminate session).
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).json({ error: "Unknown or missing mcp-session-id" });
      return;
    }
    if (entry.userId !== req.user!.userId) {
      res.status(403).json({ error: "Session belongs to another key" });
      return;
    }
    await entry.transport.handleRequest(req, res);
  };
  app.get("/mcp", requireUser, handleSessionRequest);
  app.delete("/mcp", requireUser, handleSessionRequest);

  // ── Ingest API (admin/form) ──────────────────────────────
  app.post("/api/insights", requireIngestAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    try {
      // created_by FKs ja_users — only set it for API-key users (portal user ids
      // live in Supabase auth, not ja_users).
      const createdBy = req.user?.authVia === "apikey" ? req.user.userId : undefined;
      const created = await createInsight(parsed.data, createdBy);
      res.status(201).json({ ok: true, insight: created });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Bulk ingest from a raw bilingual .md document (example.md format).
  app.post("/api/insights/from-md", requireIngestAuth, async (req, res) => {
    const md = typeof req.body?.md === "string" ? req.body.md : "";
    if (!md.trim()) {
      res.status(400).json({ error: "Body must be JSON { md: '<markdown text>' }" });
      return;
    }
    const inputs = parseBilingualMd(md);
    if (!inputs.length) {
      res.status(400).json({ error: "No reports parsed. Expected '## <date> / <id> <title>' headings." });
      return;
    }
    const created: any[] = [];
    const failed: any[] = [];
    const createdBy = req.user?.authVia === "apikey" ? req.user.userId : undefined;
    // Validate each report's 分类 against the categories defined in
    // 系统设置 → 洞察栏目分类. Undefined categories are rejected (not ingested).
    const allowed = await getInsightCategories();
    const allowedSet = new Set(allowed.map((c) => c.trim()).filter(Boolean));
    for (const input of inputs) {
      const attrs = (input.attributes ?? {}) as Record<string, unknown>;
      const cands = [input.category, attrs.category_zh, attrs.category_en]
        .map((c) => (typeof c === "string" ? c.trim() : ""))
        .filter(Boolean);
      if (allowedSet.size && !cands.some((c) => allowedSet.has(c))) {
        const shown = cands[0] || "(空)";
        failed.push({
          report_id: input.report_id,
          report_date: input.report_date,
          error: `分类「${shown}」未在「系统设置 → 洞察栏目分类」中定义，请先添加该栏目或修正 .md 后重试`,
        });
        continue;
      }
      try {
        created.push(await createInsight(input, createdBy));
      } catch (e) {
        failed.push({ report_id: input.report_id, report_date: input.report_date, error: (e as Error).message });
      }
    }
    res.status(failed.length && !created.length ? 500 : 201).json({
      ok: failed.length === 0,
      parsed: inputs.length,
      created,
      failed,
    });
  });

  // ── Browser read API (per-user access control) ───────────
  // Mirrors the MCP tools as plain REST so the web workbench can fetch
  // with `Authorization: Bearer <api_key>`.
  const langOf = (v: unknown): Lang => (v === "en" || v === "zh" ? v : "both");
  const num = (v: unknown, d: number) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : d);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  app.get("/api/me", requireUser, (req, res) => {
    const u = req.user!;
    res.json({ email: u.email, name: u.name, access_groups: u.accessGroups, is_admin: u.isAdmin, role: u.role ?? null });
  });

  // Audit trail (admin only) — the recorded agent⇄server tool-call conversation.
  app.get("/api/audit", requireUser, async (req, res) => {
    if (!req.user!.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    try {
      const result = await queryToolCalls({
        tool: str(req.query.tool),
        email: str(req.query.email),
        sessionId: str(req.query.session_id),
        errorsOnly: req.query.errors_only === "true" ? true : null,
        dateFrom: str(req.query.date_from),
        dateTo: str(req.query.date_to),
        limit: num(req.query.limit, 50),
        offset: num(req.query.offset, 0),
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── API-key management (admin only) ──────────────────────
  // The admin backend's token panel: list / mint / revoke / set-expiry of the
  // static `ja_` keys agents use. Minting upserts the user so groups/admin can
  // be set in one step; the raw key is returned ONCE.
  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!req.user!.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return false;
    }
    return true;
  };

  app.get("/api/keys", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ items: await listApiKeys() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const createKeySchema = z.object({
    email: z.string().email(),
    name: z.string().nullish(),
    groups: z.array(z.string()).optional(),
    is_admin: z.boolean().optional(),
    label: z.string().nullish(),
    // Accept a date (YYYY-MM-DD) or full ISO timestamp; empty/absent = no expiry.
    expires_at: z.string().nullish(),
    scopes: z.array(z.string()).optional(),
    // 开发者中心: 要求邮箱必须是已登记用户，不隐式创建。
    require_existing: z.boolean().optional(),
  });

  app.post("/api/keys", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    try {
      const expiresAt = normaliseExpiry(parsed.data.expires_at);
      const result = await createApiKey({
        email: parsed.data.email,
        name: parsed.data.name ?? null,
        groups: parsed.data.groups ?? [],
        isAdmin: parsed.data.is_admin ?? false,
        label: parsed.data.label ?? null,
        expiresAt,
        scopes: parsed.data.scopes ?? [],
        requireExisting: parsed.data.require_existing ?? false,
      });
      // raw key is returned exactly once.
      res.status(201).json({ ok: true, api_key: result.raw, key: result.key, user: result.user });
    } catch (e) {
      if ((e as { code?: string }).code === "user_not_found") {
        res.status(404).json({ error: "该邮箱尚未注册，请先在「用户与客户」中登记该用户后再生成 Key" });
        return;
      }
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/keys/:id/revoke", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await revokeApiKey(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/keys/:id/expiry", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await setKeyExpiry(req.params.id, normaliseExpiry(req.body?.expires_at));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Permanently delete an inactive (revoked/expired) key from the list.
  app.delete("/api/keys/:id", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await deleteApiKey(req.params.id);
      if (!r.ok) {
        if (r.reason === "active") {
          res.status(409).json({ error: "仅可删除已吊销或已过期的 Token，请先吊销" });
          return;
        }
        res.status(404).json({ error: "Token 不存在" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Workbench daily view: fully-rendered cards for one date.
  app.get("/api/daily", requireUser, async (req, res) => {
    const date = str(req.query.date);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "Query param 'date' (YYYY-MM-DD) is required" });
      return;
    }
    try {
      const cards = await getDailyCards(req.user!, date);
      res.json({ date, cards });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/insights/search", requireUser, async (req, res) => {
    const q = str(req.query.q);
    if (!q) {
      res.status(400).json({ error: "Missing query param 'q'" });
      return;
    }
    try {
      const items = await searchInsights(req.user!, {
        query: q,
        limit: num(req.query.limit, 10),
        category: str(req.query.category),
        status: str(req.query.status),
        dateFrom: str(req.query.date_from),
        dateTo: str(req.query.date_to),
        // Absent => use the server default threshold; present => honour it (0 = all).
        minSimilarity: req.query.min_similarity != null ? num(req.query.min_similarity, 0) : undefined,
        lang: langOf(req.query.lang),
      });
      res.json({ count: items.length, items });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Distinct dates the caller can see — drives the workbench date picker.
  app.get("/api/insights/dates", requireUser, async (req, res) => {
    try {
      const { items } = await listInsights(req.user!, { limit: 1000, lang: "en" });
      const dates = Array.from(new Set(items.map((i: any) => i.report_date))).sort().reverse();
      res.json({ dates });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/insights/:id", requireUser, async (req, res) => {
    try {
      const row = await getInsight(req.user!, req.params.id, langOf(req.query.lang));
      if (!row) {
        res.status(404).json({ error: "Not found or not permitted" });
        return;
      }
      res.json({ insight: row });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/insights", requireUser, async (req, res) => {
    try {
      const result = await listInsights(req.user!, {
        category: str(req.query.category),
        status: str(req.query.status),
        dateFrom: str(req.query.date_from),
        dateTo: str(req.query.date_to),
        limit: num(req.query.limit, 50),
        offset: num(req.query.offset, 0),
        lang: langOf(req.query.lang),
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Overall stats (整体数据) — real, access-filtered analytics ──
  app.get("/api/stats", requireUser, async (req, res) => {
    try {
      res.json(await getOverviewStats(req.user!));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Creative insights (创意洞察) ──────────────────────────
  app.get("/api/creative", requireUser, async (req, res) => {
    try {
      const result = await listCreative(req.user!, {
        category: str(req.query.category),
        platform: str(req.query.platform),
        dateFrom: str(req.query.date_from),
        dateTo: str(req.query.date_to),
        limit: num(req.query.limit, 24),
        offset: num(req.query.offset, 0),
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/creative/:id", requireUser, async (req, res) => {
    try {
      const row = await getCreative(req.user!, req.params.id);
      if (!row) {
        res.status(404).json({ error: "Not found or not permitted" });
        return;
      }
      res.json({ creative: row });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const creativeSchema = z.object({
    title: z.string().min(1),
    platform: z.string().nullish(),
    category: z.string().nullish(),
    link: z.string().nullish(),
    methods: z.array(z.string()).optional(),
    images: z.array(z.string()).optional(),
    body: z.record(z.any()).optional(),
    report_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    access: z.array(z.string()).optional(),
  });

  app.post("/api/creative", requireIngestAuth, async (req, res) => {
    const parsed = creativeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    try {
      const createdBy = req.user?.authVia === "apikey" ? req.user.userId : undefined;
      const created = await createCreative(
        {
          title: parsed.data.title,
          platform: parsed.data.platform ?? null,
          category: parsed.data.category ?? null,
          link: parsed.data.link ?? null,
          methods: parsed.data.methods ?? [],
          images: parsed.data.images ?? [],
          body: parsed.data.body ?? {},
          report_date: parsed.data.report_date ?? null,
          access: parsed.data.access ?? ["default"],
        },
        createdBy,
      );
      res.status(201).json({ ok: true, creative: created });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 需求社区 (community: posts + comments) ───────────────
  app.get("/api/community/posts", requireUser, async (req, res) => {
    try {
      const mine = req.query.mine === "1" || req.query.mine === "true";
      res.json(await listPosts(req.user!, { limit: num(req.query.limit, 10), offset: num(req.query.offset, 0), mine }));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 我收藏的帖子 (current user's favorited posts, newest-favorited first)
  app.get("/api/community/favorites", requireUser, async (req, res) => {
    try {
      res.json(await listFavorites(req.user!, { limit: num(req.query.limit, 10), offset: num(req.query.offset, 0) }));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 我点赞的帖子 (current user's liked posts, newest-liked first)
  app.get("/api/community/likes", requireUser, async (req, res) => {
    try {
      res.json(await listLikes(req.user!, { limit: num(req.query.limit, 10), offset: num(req.query.offset, 0) }));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Attachments arrive as base64 data-URLs; allowed file kinds + 15MB/file cap.
  const ALLOWED_FILE_EXT = ["md","markdown","html","htm","pdf","txt","csv","json","docx","doc","xlsx","xls","pptx","ppt","png","jpg","jpeg","gif","webp","svg","zip"];
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const postSchema = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
    attachments: z.array(z.object({ data: z.string().min(1), name: z.string().min(1).max(160) })).max(10).optional(),
  });
  app.post("/api/community/posts", requireUser, async (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "标题和内容不能为空" });
      return;
    }
    try {
      const resolved: Array<{ name: string; url: string; type: string; size: number }> = [];
      for (const att of parsed.data.attachments ?? []) {
        const ext = (att.name.split(".").pop() || "").toLowerCase();
        if (!ALLOWED_FILE_EXT.includes(ext)) {
          res.status(400).json({ error: `不支持的文件类型 .${ext}（支持 md/html/pdf 等）` });
          return;
        }
        if (Math.floor(att.data.length * 0.75) > MAX_FILE_BYTES) {
          res.status(400).json({ error: `文件过大（单个上限 15MB）：${att.name}` });
          return;
        }
        const up = await uploadFile(att.data, att.name);
        resolved.push({ name: up.name, url: up.url, type: up.type, size: up.size });
      }
      res.status(201).json({ ok: true, post: await createPost(req.user!, parsed.data.title, parsed.data.body, resolved) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 编辑自己的帖子（仅作者或管理员；标题/正文）
  const postUpdateSchema = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
  });
  app.put("/api/community/posts/:id", requireUser, async (req, res) => {
    const parsed = postUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "标题和内容不能为空" });
      return;
    }
    try {
      const r = await updatePost(req.user!, req.params.id, { title: parsed.data.title, body: parsed.data.body });
      if (!r.ok) {
        res.status(r.reason === "forbidden" ? 403 : 404).json({ error: r.reason === "forbidden" ? "只能编辑自己的帖子" : "帖子不存在" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 删除自己的帖子（仅作者或管理员；评论/点赞/收藏级联删除）
  app.delete("/api/community/posts/:id", requireUser, async (req, res) => {
    try {
      const r = await deletePost(req.user!, req.params.id);
      if (!r.ok) {
        res.status(r.reason === "forbidden" ? 403 : 404).json({ error: r.reason === "forbidden" ? "只能删除自己的帖子" : "帖子不存在" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/community/posts/:id", requireUser, async (req, res) => {
    try {
      const result = await getPost(req.user!, req.params.id);
      if (!result) {
        res.status(404).json({ error: "帖子不存在" });
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 点赞 / 收藏 (toggle via POST=on / DELETE=off; idempotent) ──
  app.post("/api/community/posts/:id/like", requireUser, async (req, res) => {
    try {
      const r = await toggleLike(req.user!, req.params.id, true);
      if (!r) { res.status(404).json({ error: "帖子不存在" }); return; }
      res.json(r);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.delete("/api/community/posts/:id/like", requireUser, async (req, res) => {
    try {
      const r = await toggleLike(req.user!, req.params.id, false);
      if (!r) { res.status(404).json({ error: "帖子不存在" }); return; }
      res.json(r);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.post("/api/community/posts/:id/favorite", requireUser, async (req, res) => {
    try {
      const r = await toggleFavorite(req.user!, req.params.id, true);
      if (!r) { res.status(404).json({ error: "帖子不存在" }); return; }
      res.json(r);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.delete("/api/community/posts/:id/favorite", requireUser, async (req, res) => {
    try {
      const r = await toggleFavorite(req.user!, req.params.id, false);
      if (!r) { res.status(404).json({ error: "帖子不存在" }); return; }
      res.json(r);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  const postCommentSchema = z.object({ body: z.string().min(1).max(5000) });
  app.post("/api/community/posts/:id/comments", requireUser, async (req, res) => {
    const parsed = postCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "评论内容不能为空" });
      return;
    }
    try {
      const created = await addPostComment(req.user!, req.params.id, parsed.data.body);
      if (!created) {
        res.status(404).json({ error: "帖子不存在" });
        return;
      }
      res.status(201).json({ ok: true, comment: created });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 需求意见箱 (suggestions: submit by any user, triage by admins) ──
  const suggestionSchema = z.object({
    category: z.string().max(60).nullish(),
    body: z.string().min(1).max(5000),
  });
  app.post("/api/suggestions", requireUser, async (req, res) => {
    const parsed = suggestionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "请填写建议内容" });
      return;
    }
    try {
      const s = await createSuggestion(req.user!, parsed.data.category ?? null, parsed.data.body);
      res.status(201).json({ ok: true, suggestion: s });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.get("/api/suggestions", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const status = typeof req.query.status === "string" ? req.query.status : null;
      res.json(await listSuggestions({ status, limit: num(req.query.limit, 100), offset: num(req.query.offset, 0) }));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  const suggestionStatusSchema = z.object({ status: z.enum(["unread", "adopted"]) });
  app.patch("/api/suggestions/:id", requireUser, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = suggestionStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "状态无效" });
      return;
    }
    try {
      const ok = await setSuggestionStatus(req.params.id, parsed.data.status);
      if (!ok) {
        res.status(404).json({ error: "记录不存在" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Per-user app state (insight marks: 收藏/已使用/促成销售) ──
  app.get("/api/state", requireUser, async (req, res) => {
    try {
      const raw = String(req.query.keys ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const keys = raw.length ? raw : [...STATE_KEYS];
      res.json(await getUserState(req.user!, keys));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const stateSchema = z.object({ value: z.unknown() });
  app.put("/api/state/:key", requireUser, async (req, res) => {
    const parsed = stateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "missing value" });
      return;
    }
    const val = parsed.data.value;
    if (Array.isArray(val) && val.length > 5000) {
      res.status(400).json({ error: "too many items (max 5000)" });
      return;
    }
    try {
      res.json(await setUserState(req.user!, req.params.key, val));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 洞察栏目分类 (insight categories; admin-managed) ────────
  app.get("/api/settings/categories", requireUser, async (_req, res) => {
    try {
      res.json({ categories: await getInsightCategories() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const categoriesSchema = z.object({ value: z.array(z.string().min(1).max(40)).max(200) });
  app.put("/api/settings/categories", requireUser, async (req, res) => {
    if (!req.user!.isAdmin) {
      res.status(403).json({ error: "仅管理员可修改栏目分类" });
      return;
    }
    const parsed = categoriesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "栏目分类格式不正确" });
      return;
    }
    try {
      const cats = Array.from(new Set(parsed.data.value.map((s) => s.trim()).filter(Boolean)));
      await setSetting("insight_categories", cats);
      res.json({ ok: true, categories: cats });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Public daily-insights API (other projects, per-target-user access) ──
  // Auth: API key (Bearer) with admin OR scope "query:daily". The `user` param
  // names the END user whose access scope decides what's returned — resolved
  // server-side from ja_users, never from caller-supplied groups.
  //
  //   GET /api/v1/daily/dates?user=<email>
  //   GET /api/v1/daily?user=<email>&date=<YYYY-MM-DD>&lang=en|zh|both&format=insights|cards
  app.get("/api/v1/daily/dates", requireDailyApi, async (req, res) => {
    const email = str(req.query.user);
    if (!email) {
      res.status(400).json({ error: "缺少查询参数 user（目标用户邮箱）" });
      return;
    }
    try {
      const target = await resolveTargetUser(email);
      if (!target) {
        res.status(404).json({ error: `目标用户不存在或未启用：${email}` });
        return;
      }
      const { items } = await listInsights(target, { limit: 1000, lang: "en" });
      const dates = Array.from(new Set(items.map((i: any) => i.report_date))).sort().reverse();
      res.json({ user: { email: target.email }, dates });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/v1/daily", requireDailyApi, async (req, res) => {
    const email = str(req.query.user);
    const date = str(req.query.date);
    if (!email) {
      res.status(400).json({ error: "缺少查询参数 user（目标用户邮箱）" });
      return;
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "缺少或非法的 date（YYYY-MM-DD）" });
      return;
    }
    const lang = langOf(req.query.lang);
    try {
      const target = await resolveTargetUser(email);
      if (!target) {
        res.status(404).json({ error: `目标用户不存在或未启用：${email}` });
        return;
      }
      const userInfo = { email: target.email, name: target.name, access_groups: target.accessGroups };
      if (str(req.query.format) === "cards") {
        const cards = await getDailyCards(target, date);
        res.json({ date, user: userInfo, count: cards.length, cards });
      } else {
        const insights = await getDailyInsights(target, date, lang);
        res.json({ date, user: userInfo, count: insights.length, insights });
      }
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Static (submit form + workbench) ─────────────────────
  app.use("/", express.static(publicDir));

  return app;
}
