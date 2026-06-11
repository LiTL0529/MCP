import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { resolveApiKey } from "./auth.js";
import { queryToolCalls, recordSession } from "./audit.js";
import { buildMcpServer } from "./mcp.js";
import { createInsight, getDailyCards, getInsight, listInsights, searchInsights } from "./insights.js";
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

// ── Auth middleware (MCP read path) ────────────────────────
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const raw = bearer(req);
  if (!raw) {
    res.status(401).json({ error: "Missing 'Authorization: Bearer <api_key>' header" });
    return;
  }
  const user = await resolveApiKey(raw);
  if (!user) {
    res.status(401).json({ error: "Invalid or revoked API key" });
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
  const raw = bearer(req);
  if (raw) {
    const user = await resolveApiKey(raw);
    if (user?.isAdmin) {
      req.user = user;
      next();
      return;
    }
  }
  res.status(401).json({ error: "Ingest requires the INGEST_TOKEN header or an admin API key" });
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
      const created = await createInsight(parsed.data, req.user?.userId);
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
    for (const input of inputs) {
      try {
        created.push(await createInsight(input, req.user?.userId));
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
    res.json({ email: u.email, name: u.name, access_groups: u.accessGroups, is_admin: u.isAdmin });
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

  // ── Static (submit form + workbench) ─────────────────────
  app.use("/", express.static(publicDir));

  return app;
}
