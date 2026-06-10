import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getInsight, listInsights, searchInsights } from "./insights.js";
import type { UserContext } from "./types.js";

const langSchema = z
  .enum(["en", "zh", "both"])
  .describe("Which language(s) to return. 'both' (default) lets the frontend toggle.");

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Build an MCP server bound to a single authenticated user. Every tool
 * closes over `user`, so the access groups can never be spoofed by tool args.
 */
export function buildMcpServer(user: UserContext): McpServer {
  const server = new McpServer({
    name: "ja-insight-hub",
    version: "0.1.0",
  });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the authenticated user, their access groups, and admin flag. Useful to confirm which insights you are allowed to see.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        email: user.email,
        name: user.name,
        access_groups: user.accessGroups,
        is_admin: user.isAdmin,
        note: user.isAdmin
          ? "Admin: you can see every insight."
          : "You can see insights whose access is 'default' (public) or overlaps your access groups.",
      }),
  );

  server.registerTool(
    "search_insights",
    {
      title: "Search insights (semantic)",
      description:
        "Semantic search over the insight reports you are allowed to access. Each article is embedded as up to FOUR separate vectors (English title / summary / key attributes / image descriptions); the query is scored against each and the article's rank is the MAX. Returns one full bilingual article per match (deduped), including any `images` (url + caption + description), with `similarity` and `matched_field` (one of title/summary/attributes/image).",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language query (any language)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
        category: z.string().optional().describe("Filter by category (exact match)."),
        status: z.string().optional().describe("Filter by status, e.g. RADAR."),
        date_from: z.string().optional().describe("Inclusive lower bound, YYYY-MM-DD."),
        date_to: z.string().optional().describe("Inclusive upper bound, YYYY-MM-DD."),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Drop results below this cosine similarity (0–1)."),
        lang: langSchema.optional(),
      },
    },
    async (args) => {
      try {
        const items = await searchInsights(user, {
          query: args.query,
          limit: args.limit,
          category: args.category ?? null,
          status: args.status ?? null,
          dateFrom: args.date_from ?? null,
          dateTo: args.date_to ?? null,
          minSimilarity: args.min_similarity,
          lang: args.lang ?? "both",
        });
        return jsonResult({ count: items.length, items });
      } catch (e) {
        return errorResult(`search_insights error: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_insights",
    {
      title: "List insights (browse/filter)",
      description:
        "Browse the insight reports you are allowed to access, newest first, with optional filters and pagination. No semantic query — use search_insights for that.",
      inputSchema: {
        category: z.string().optional(),
        status: z.string().optional(),
        date_from: z.string().optional().describe("Inclusive lower bound, YYYY-MM-DD."),
        date_to: z.string().optional().describe("Inclusive upper bound, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
        offset: z.number().int().min(0).optional().describe("Page offset (default 0)."),
        lang: langSchema.optional(),
      },
    },
    async (args) => {
      try {
        const result = await listInsights(user, {
          category: args.category ?? null,
          status: args.status ?? null,
          dateFrom: args.date_from ?? null,
          dateTo: args.date_to ?? null,
          limit: args.limit,
          offset: args.offset,
          lang: args.lang ?? "both",
        });
        return jsonResult(result);
      } catch (e) {
        return errorResult(`list_insights error: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_insight",
    {
      title: "Get one insight (full report)",
      description:
        "Fetch the full bilingual report by its id (the uuid returned by search/list). Returns title, summary, insight, recommendations, sources, and recommended services. Returns not_found if the report does not exist or you are not allowed to see it.",
      inputSchema: {
        id: z.string().uuid().describe("The insight uuid from search_insights/list_insights."),
        lang: langSchema.optional(),
      },
    },
    async (args) => {
      try {
        const row = await getInsight(user, args.id, args.lang ?? "both");
        if (!row) return jsonResult({ found: false, reason: "not_found_or_forbidden" });
        return jsonResult({ found: true, insight: row });
      } catch (e) {
        return errorResult(`get_insight error: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
