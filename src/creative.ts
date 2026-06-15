import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── Creative insights (video decode) ───────────────────────
// Access mirrors ja_insights: employees (seeAll) see everything; others see
// rows whose access[] overlaps their groups or is 'default'. Ingest is gated to
// admins by the HTTP layer. Uses the service-role client; the filter is applied
// here in code (the table is RLS-restricted / service-role only).

const SUMMARY_COLS =
  "id, title, platform, category, link, methods, images, report_date, access, created_at";

function applyAccess(query: any, user: UserContext) {
  // seeAll (employees/admin) → no restriction; otherwise the row's access[]
  // must overlap the caller's groups OR contain 'default' (public).
  if (user.seeAll) return query;
  const groups = [...(user.accessGroups ?? []), "default"];
  return query.overlaps("access", groups);
}

export interface CreativeListParams {
  category?: string | null;
  platform?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
  offset?: number;
}

export async function listCreative(user: UserContext, params: CreativeListParams) {
  const limit = Math.min(Math.max(params.limit ?? 24, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  let query = supabase.from("ja_creative_insights").select(SUMMARY_COLS, { count: "exact" });
  query = applyAccess(query, user);
  if (params.category) query = query.eq("category", params.category);
  if (params.platform) query = query.eq("platform", params.platform);
  if (params.dateFrom) query = query.gte("report_date", params.dateFrom);
  if (params.dateTo) query = query.lte("report_date", params.dateTo);

  const { data, count, error } = await query
    .order("report_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`listCreative failed: ${error.message}`);
  return { total: count ?? 0, limit, offset, items: data ?? [] };
}

export async function getCreative(user: UserContext, id: string) {
  let query = supabase.from("ja_creative_insights").select("*").eq("id", id);
  query = applyAccess(query, user);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`getCreative failed: ${error.message}`);
  return data ?? null; // null => not found or not permitted
}

export interface CreateCreativeInput {
  title: string;
  platform?: string | null;
  category?: string | null;
  link?: string | null;
  methods?: string[];
  images?: string[];
  body?: Record<string, unknown>;
  report_date?: string | null;
  access?: string[];
}

export async function createCreative(input: CreateCreativeInput, createdBy?: string) {
  const row = {
    title: input.title,
    platform: input.platform ?? null,
    category: input.category ?? null,
    link: input.link ?? null,
    methods: input.methods ?? [],
    images: input.images ?? [],
    body: input.body ?? {},
    report_date: input.report_date ?? new Date().toISOString().slice(0, 10),
    access: input.access && input.access.length ? input.access : ["default"],
    created_by: createdBy ?? null,
  };
  const { data, error } = await supabase
    .from("ja_creative_insights")
    .insert(row)
    .select("id, title, report_date")
    .single();
  if (error) throw new Error(`createCreative failed: ${error.message}`);
  return data;
}

/** Counts grouped by YYYY-MM of report_date (for the 创意洞察发布趋势 chart). */
export async function creativeMonthlyTrend(user: UserContext) {
  let query = supabase.from("ja_creative_insights").select("report_date");
  query = applyAccess(query, user);
  const { data, error } = await query;
  if (error) throw new Error(`creativeMonthlyTrend failed: ${error.message}`);
  const buckets: Record<string, number> = {};
  for (const r of data ?? []) {
    const m = String((r as any).report_date).slice(0, 7); // YYYY-MM
    buckets[m] = (buckets[m] ?? 0) + 1;
  }
  return Object.keys(buckets)
    .sort()
    .map((bucket) => ({ bucket, count: buckets[bucket] }));
}
