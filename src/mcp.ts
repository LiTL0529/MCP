import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { queryToolCalls, recordToolCall } from "./audit.js";
import { aggregateInsights, getInsight, listInsights, searchInsights } from "./insights.js";
import { introspectSchema, isSqlEnabled, runReadonlySql } from "./readonly-db.js";
import type { UserContext } from "./types.js";

// Tables the run_sql tool / schema resource expose. Extend as you normalise
// the model into more tables (and grant ja_reader SELECT on them in a migration).
const QUERYABLE_TABLES = ["ja_insights"];

// Server-level instructions: returned in the `initialize` response so the
// calling client can put them in the model's context. This is how we steer the
// user's agent to be transparent about what this server returned. (Advisory —
// the client model ultimately decides how to present results.)
const SERVER_INSTRUCTIONS = [
  "JA Insight Hub is the authoritative, access-controlled source for JA insight reports.",
  "Whenever you use these tools, ALWAYS report back to the user (in the user's language):",
  "(1) whether the server returned valid results — read the `found` flag and `count`;",
  "(2) the actual returned content (title / summary / key points), citing it instead of answering from your own knowledge.",
  "If `found` is false or `count` is 0, tell the user explicitly that no matching insight was found",
  "(this can also mean the current API key has no access) — do NOT invent or fill in insights that were not returned by the tool.",
].join(" ");

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
  const server = new McpServer(
    { name: "ja-insight-hub", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Wrap every tool registration so each call (args + result summary + latency,
  // bound to this user/session) is persisted as an audit record of the agent⇄
  // server conversation. Logging is best-effort and never alters the result.
  const register = (name: string, def: any, handler: (args: any, extra: any) => any) =>
    (server.registerTool as any)(name, def, async (args: any, extra: any) => {
      const started = Date.now();
      try {
        const res = await handler(args, extra);
        recordToolCall({ user, sessionId: extra?.sessionId, tool: name, args, result: res, latencyMs: Date.now() - started });
        return res;
      } catch (e) {
        recordToolCall({ user, sessionId: extra?.sessionId, tool: name, args, error: (e as Error).message, latencyMs: Date.now() - started });
        throw e;
      }
    });

  register(
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

  register(
    "search_insights",
    {
      title: "Search insights (semantic)",
      description:
        "Semantic search over the insight reports you are allowed to access. Each article is embedded as up to four separate vectors (English title / summary / key attributes / image descriptions) and ranked by its best match; results come back most-relevant first. Returns one full bilingual article per match (deduped), including any `images` (url + caption + description), plus `found`, `count` and a `report` line. When answering, state whether anything was found (use `found`/`count`) and summarise the returned `items` content (title / summary / key points) instead of answering from your own knowledge; if `found` is false, tell the user no matching insight was found.",
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
          .describe(
            "Drop results below this cosine similarity (0–1). Omit to use the server's default threshold (weak matches are already filtered out); pass 0 to return all matches.",
          ),
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
        // Provenance only — whether anything was found, so the agent doesn't
        // fabricate. No relevance score or matched-field is surfaced.
        return jsonResult({
          source: "ja-insight-hub",
          query: args.query,
          found: items.length > 0,
          count: items.length,
          report: items.length
            ? `Found ${items.length} insight(s). ` +
              `Tell the user these came from JA Insight Hub and cite the returned content (title / summary / key points) instead of answering from your own knowledge.`
            : `No accessible insight was found (nothing relevant exists, or this key/login has no access). ` +
              `Tell the user no matching insight was found — do not fabricate one.`,
          items,
        });
      } catch (e) {
        return errorResult(`search_insights error: ${(e as Error).message}`);
      }
    },
  );

  register(
    "list_insights",
    {
      title: "List / browse insights (exact filters, not semantic)",
      description:
        "Enumerate the insight reports you can access, filtered by EXACT fields (category / status / date range) and sorted newest-first — NOT ranked by relevance. Use this (not search_insights) when the user wants a COMPLETE set rather than the few most relevant: e.g. 'all insights in May', 'every RADAR report', 'list the education-category insights'. This is the tool to gather a full candidate set before summarising across many records. Returns summary rows (title + summary + attributes + images), plus `total` (the full match size, for paging) — call again with a larger `offset` to walk every page, then call get_insight for any full body you need. For 'how many / breakdown / trend' questions, prefer aggregate_insights instead of counting these rows yourself.",
      inputSchema: {
        category: z.string().optional().describe("Filter by category (exact match)."),
        status: z.string().optional().describe("Filter by status, e.g. RADAR."),
        date_from: z.string().optional().describe("Inclusive lower bound, YYYY-MM-DD."),
        date_to: z.string().optional().describe("Inclusive upper bound, YYYY-MM-DD."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Page size (default 50, max 200)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip for paging (default 0)."),
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
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          lang: args.lang ?? "both",
        });
        const returned = result.items.length;
        const seen = (args.offset ?? 0) + returned;
        return jsonResult({
          source: "ja-insight-hub",
          found: result.total > 0,
          total: result.total,
          count: returned,
          limit: result.limit,
          offset: result.offset,
          has_more: seen < result.total,
          report:
            result.total === 0
              ? "No accessible insight matched these filters (or this API key has no access). Tell the user none were found — do not fabricate."
              : `${result.total} insight(s) match these filters; returned ${returned} (offset ${result.offset}).` +
                (seen < result.total
                  ? ` More remain — call again with offset ${seen} to get the rest before summarising across all of them.`
                  : " This is the complete set."),
          items: result.items,
        });
      } catch (e) {
        return errorResult(`list_insights error: ${(e as Error).message}`);
      }
    },
  );

  register(
    "aggregate_insights",
    {
      title: "Aggregate insights (counts / breakdown / trend)",
      description:
        "Return COUNTS computed in the database, grouped by one field — use this for 'how many', 'breakdown by category', or 'trend over time' questions instead of listing rows and counting them yourself (which is error-prone). `group_by` is one of: 'category', 'status', 'type', or 'month' (buckets by report_date as YYYY-MM, returned in chronological order — ideal for trend lines). Optional category/status/date filters narrow the population first. Returns `buckets` ([{bucket, count}]) and a `total`. Report the numbers verbatim; if you need the underlying articles for a bucket, follow up with list_insights using the same filters.",
      inputSchema: {
        group_by: z
          .enum(["category", "status", "type", "month"])
          .optional()
          .describe("Field to group counts by (default 'category'). 'month' = trend over time."),
        category: z.string().optional().describe("Restrict to this category before counting."),
        status: z.string().optional().describe("Restrict to this status before counting."),
        date_from: z.string().optional().describe("Inclusive lower bound, YYYY-MM-DD."),
        date_to: z.string().optional().describe("Inclusive upper bound, YYYY-MM-DD."),
      },
    },
    async (args) => {
      try {
        const result = await aggregateInsights(user, {
          groupBy: args.group_by ?? "category",
          category: args.category ?? null,
          status: args.status ?? null,
          dateFrom: args.date_from ?? null,
          dateTo: args.date_to ?? null,
        });
        return jsonResult({
          source: "ja-insight-hub",
          found: result.total > 0,
          group_by: result.group_by,
          total: result.total,
          bucket_count: result.buckets.length,
          report:
            result.total === 0
              ? "No accessible insight matched these filters (or this API key has no access). Tell the user none were found — do not fabricate counts."
              : `${result.total} insight(s) across ${result.buckets.length} ${result.group_by} bucket(s). These counts are computed by the database — report them as-is.`,
          buckets: result.buckets,
        });
      } catch (e) {
        return errorResult(`aggregate_insights error: ${(e as Error).message}`);
      }
    },
  );

  register(
    "get_insight",
    {
      title: "Get one insight (full report)",
      description:
        "Fetch the full bilingual report by its id (the uuid returned by search_insights). Returns title, summary, insight, recommendations, sources, recommended services, and images. Returns not_found if the report does not exist or you are not allowed to see it.",
      inputSchema: {
        id: z.string().uuid().describe("The insight uuid from search_insights."),
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

  // ── Audit trail read-back (admin only) ────────────────────────────────────
  // The recorded agent⇄server conversation. Only registered for admins, so it
  // never appears in a normal user's tool list.
  if (user.isAdmin) {
    register(
      "list_tool_calls",
      {
        title: "List tool-call audit log (admin)",
        description:
          "Admin-only. Browse the recorded agent⇄server conversation — every MCP tool call with its arguments (the user's query / the agent's SQL), result summary, success/error and latency. Filter by tool, user email, session_id, errors-only, or date range; results are newest-first with a `total` for paging. Pass a session_id to pull one whole session's exchange. Returns lean rows (no full payloads).",
        inputSchema: {
          tool: z.string().optional().describe("Filter by tool name, e.g. search_insights / run_sql."),
          email: z.string().optional().describe("Filter by the calling user's email."),
          session_id: z.string().optional().describe("Filter to one MCP session's calls."),
          errors_only: z.boolean().optional().describe("Only failed calls."),
          date_from: z.string().optional().describe("Inclusive lower bound (ISO timestamp or YYYY-MM-DD)."),
          date_to: z.string().optional().describe("Inclusive upper bound (ISO timestamp or YYYY-MM-DD)."),
          limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for paging (default 0)."),
        },
      },
      async (args) => {
        try {
          const result = await queryToolCalls({
            tool: args.tool ?? null,
            email: args.email ?? null,
            sessionId: args.session_id ?? null,
            errorsOnly: args.errors_only ?? null,
            dateFrom: args.date_from ?? null,
            dateTo: args.date_to ?? null,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          });
          const seen = result.offset + result.items.length;
          return jsonResult({
            source: "ja-insight-hub",
            found: result.total > 0,
            total: result.total,
            count: result.items.length,
            limit: result.limit,
            offset: result.offset,
            has_more: seen < result.total,
            items: result.items,
          });
        } catch (e) {
          return errorResult(`list_tool_calls error: ${(e as Error).message}`);
        }
      },
    );
  }

  // ── Ad-hoc cross-table SQL (only when a ja_reader DSN is configured) ───────
  // Lets the agent author its own JOIN / aggregation queries. Safety is NOT in
  // this tool or the agent's SQL — it's in the database: the query runs as the
  // low-privilege, read-only `ja_reader` role under RLS, with the caller's
  // (groups, is_admin) injected server-side from `user`. The agent therefore
  // physically cannot read rows it isn't allowed to, no matter what SQL it writes.
  if (isSqlEnabled) {
    server.registerResource(
      "schema",
      "schema://ja-insights",
      {
        title: "JA Insight Hub — queryable SQL schema",
        description:
          "The exact tables and columns you may query with run_sql, generated live from the database. Embedding/vector and internal columns are omitted. Access control is applied automatically — never filter by access/groups yourself.",
        mimeType: "text/plain",
      },
      async (uri) => {
        try {
          const schema = await introspectSchema(QUERYABLE_TABLES);
          return { contents: [{ uri: uri.href, mimeType: "text/plain", text: schema }] };
        } catch (e) {
          return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `-- schema unavailable: ${(e as Error).message}` }] };
        }
      },
    );

    register(
      "run_sql",
      {
        title: "Run read-only SQL (cross-table joins / aggregation)",
        description:
          "Run ONE read-only SQL query (SELECT or WITH only) for cross-table JOINs or aggregations that search_insights / list_insights / aggregate_insights cannot express. " +
          "Rows are filtered automatically to what your API key may access — even across JOINs — so DO NOT add access/group conditions yourself; you cannot reach other tenants' rows. " +
          "Read the schema://ja-insights resource for the exact tables and columns. Avoid SELECT * and never select *_embedding columns (they are not accessible). " +
          "At most " + config.sqlMaxRows + " rows are returned (a `truncated` flag signals overflow); queries time out after " + config.sqlTimeoutMs + " ms. " +
          "Returns { columns, rows, row_count, truncated }. Use search_insights for 'most relevant', list_insights for simple single-table filters.",
        inputSchema: {
          sql: z
            .string()
            .min(1)
            .describe("A single read-only SELECT/WITH statement. No ';', no writes/DDL. List columns explicitly (no SELECT *)."),
        },
      },
      async (args) => {
        try {
          const result = await runReadonlySql(args.sql, user.accessGroups, user.seeAll);
          return jsonResult({
            source: "ja-insight-hub",
            columns: result.columns,
            row_count: result.row_count,
            truncated: result.truncated,
            report:
              result.row_count === 0
                ? "Query ran but returned no rows you can access. Tell the user none were found — do not fabricate."
                : `Returned ${result.row_count} row(s)${result.truncated ? ` (truncated at ${config.sqlMaxRows} — refine or aggregate)` : ""}. These rows are already access-filtered by the database.`,
            rows: result.rows,
          });
        } catch (e) {
          return errorResult(`run_sql error: ${(e as Error).message}`);
        }
      },
    );
  }

  return server;
}
