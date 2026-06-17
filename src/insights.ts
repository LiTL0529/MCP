import { supabase } from "./supabase.js";
import { config } from "./config.js";
import { buildFieldInputs, describeImage, embed, embedMany } from "./embeddings.js";
import { uploadImage } from "./storage.js";
import { toDailyCard, type DailyCard } from "./cardmap.js";
import type { ImageInput, ImageRef, Lang, SourceRef, UserContext } from "./types.js";

// ── Inputs ─────────────────────────────────────────────────
export interface SearchParams {
  query: string;
  limit?: number;
  category?: string | null;
  status?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  minSimilarity?: number;
  lang?: Lang;
}

export interface ListParams {
  category?: string | null;
  status?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
  offset?: number;
  lang?: Lang;
}

export type AggregateGroupBy = "category" | "status" | "type" | "month";

export interface AggregateParams {
  groupBy?: AggregateGroupBy;
  category?: string | null;
  status?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface CreateInsightInput {
  report_id: string;
  report_date: string;
  access?: string[];
  attributes?: Record<string, unknown>;
  category?: string | null;
  status?: string | null;
  type?: string | null;
  creator?: string | null;
  clients?: string | null;
  tracks?: string | null;
  title_en: string;
  title_zh?: string | null;
  summary_en: string;
  summary_zh?: string | null;
  insight_en?: string | null;
  insight_zh?: string | null;
  recommendations_en?: string[];
  recommendations_zh?: string[];
  sources?: SourceRef[];
  recommended_services_en?: string[];
  recommended_services_zh?: string[];
  images?: ImageInput[];
}

// ── Language shaping ───────────────────────────────────────
function pickLang<T>(en: T, zh: T, lang: Lang): { en?: T; zh?: T } {
  if (lang === "en") return { en };
  if (lang === "zh") return { zh };
  return { en, zh };
}

function shapeSummaryRow(r: any, lang: Lang) {
  return {
    id: r.id,
    report_id: r.report_id,
    report_date: r.report_date,
    access: r.access,
    category: r.category,
    status: r.status,
    type: r.type,
    clients: r.clients,
    tracks: r.tracks,
    title: pickLang(r.title_en, r.title_zh, lang),
    summary: pickLang(r.summary_en, r.summary_zh, lang),
    attributes: r.attributes,
    images: r.images ?? [],
  };
}

function shapeFullRow(r: any, lang: Lang) {
  return {
    id: r.id,
    report_id: r.report_id,
    report_date: r.report_date,
    access: r.access,
    category: r.category,
    status: r.status,
    type: r.type,
    creator: r.creator,
    clients: r.clients,
    tracks: r.tracks,
    attributes: r.attributes,
    title: pickLang(r.title_en, r.title_zh, lang),
    summary: pickLang(r.summary_en, r.summary_zh, lang),
    insight: pickLang(r.insight_en, r.insight_zh, lang),
    recommendations: pickLang(r.recommendations_en, r.recommendations_zh, lang),
    sources: r.sources,
    recommended_services: pickLang(r.recommended_services_en, r.recommended_services_zh, lang),
    images: r.images ?? [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Read path ──────────────────────────────────────────────
export async function searchInsights(user: UserContext, params: SearchParams) {
  const lang = params.lang ?? "both";
  const queryEmbedding = await embed(params.query);

  const { data, error } = await supabase.rpc("ja_match_insights", {
    query_embedding: queryEmbedding,
    p_groups: user.accessGroups,
    p_is_admin: user.seeAll,
    match_count: params.limit ?? 10,
    p_category: params.category ?? null,
    p_status: params.status ?? null,
    p_date_from: params.dateFrom ?? null,
    p_date_to: params.dateTo ?? null,
    // Default threshold drops weak matches; an explicit value (incl. 0) wins.
    min_similarity: params.minSimilarity ?? config.searchMinSimilarity,
  });

  if (error) throw new Error(`ja_match_insights failed: ${error.message}`);
  // Returns full bilingual articles (one per article, deduped), ranked
  // most-relevant first. The relevance score / matched field are NOT surfaced.
  return (data ?? []).map((r: any) => shapeFullRow(r, lang));
}

export async function listInsights(user: UserContext, params: ListParams) {
  const lang = params.lang ?? "both";
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  const { data, error } = await supabase.rpc("ja_list_insights", {
    p_groups: user.accessGroups,
    p_is_admin: user.seeAll,
    p_category: params.category ?? null,
    p_status: params.status ?? null,
    p_date_from: params.dateFrom ?? null,
    p_date_to: params.dateTo ?? null,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) throw new Error(`ja_list_insights failed: ${error.message}`);
  const rows = data ?? [];
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    total,
    limit,
    offset,
    items: rows.map((r: any) => shapeSummaryRow(r, lang)),
  };
}

// Counts grouped by category/status/type/month, computed in Postgres so the
// model never has to enumerate-and-tally. Returns the buckets plus a total.
export async function aggregateInsights(user: UserContext, params: AggregateParams) {
  const groupBy: AggregateGroupBy = params.groupBy ?? "category";
  const { data, error } = await supabase.rpc("ja_aggregate_insights", {
    p_groups: user.accessGroups,
    p_is_admin: user.seeAll,
    p_group_by: groupBy,
    p_category: params.category ?? null,
    p_status: params.status ?? null,
    p_date_from: params.dateFrom ?? null,
    p_date_to: params.dateTo ?? null,
  });

  if (error) throw new Error(`ja_aggregate_insights failed: ${error.message}`);
  const buckets = (data ?? []).map((r: any) => ({ bucket: r.bucket, count: Number(r.count) }));
  const total = buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0);
  return { group_by: groupBy, total, buckets };
}

export async function getInsight(user: UserContext, id: string, lang: Lang = "both") {
  const { data, error } = await supabase.rpc("ja_get_insight", {
    p_id: id,
    p_groups: user.accessGroups,
    p_is_admin: user.seeAll,
  });

  if (error) throw new Error(`ja_get_insight failed: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) return null; // not found OR not permitted — caller can't tell
  return shapeFullRow(row, lang);
}

// ── Workbench daily view ───────────────────────────────────
// Returns the fully-rendered DailyCard[] for one date, access-filtered.
// Reuses the access-controlled RPCs (list + per-id fetch) so visibility is
// never re-implemented outside Postgres.
export async function getDailyCards(user: UserContext, date: string): Promise<DailyCard[]> {
  const { items } = await listInsights(user, {
    dateFrom: date,
    dateTo: date,
    limit: 200,
    lang: "both",
  });
  const fulls = await Promise.all(items.map((i: any) => getInsight(user, i.id, "both")));
  return fulls
    .filter(Boolean)
    .map((f) => toDailyCard(f))
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
}

// ── Public API daily view (structured, non-HTML) ───────────
// Same access-controlled fetch as getDailyCards, but returns the structured
// full insights (title/summary/insight/... as data, not pre-rendered HTML) so
// external consumers can render them however they like. Honours `lang`.
export async function getDailyInsights(user: UserContext, date: string, lang: Lang = "both") {
  const { items } = await listInsights(user, { dateFrom: date, dateTo: date, limit: 200, lang });
  const fulls = await Promise.all(items.map((i: any) => getInsight(user, i.id, lang)));
  return fulls
    .filter(Boolean)
    .sort((a: any, b: any) =>
      String(a.report_id ?? "").localeCompare(String(b.report_id ?? ""), undefined, { numeric: true }),
    );
}

// ── Write path (ingestion) ─────────────────────────────────
export async function createInsight(input: CreateInsightInput, createdBy?: string) {
  const access = input.access && input.access.length ? input.access : ["default"];

  const fieldInputs = buildFieldInputs({
    titleEn: input.title_en,
    summaryEn: input.summary_en,
    attributes: input.attributes,
    category: input.category,
    status: input.status,
    type: input.type,
    clients: input.clients,
    tracks: input.tracks,
    reportDate: input.report_date,
    access,
  });
  // Images: upload each file, ask the vision model to describe it, and collect
  // the descriptions into one text that becomes the image vector. The query is
  // text-embedded, so the description (not the pixels) is what makes an image
  // matchable in the same space as the title/summary/attributes vectors.
  const { images, imageEmbInput } = await processImages(input.images ?? []);

  // Re-vectorize ONLY the embedding fields whose input actually changed. This is
  // an upsert (onConflict report_date,report_id), so on an edit / re-upload we
  // fetch the existing row and reuse its stored vector for any field whose
  // embed-input matches — unchanged title/summary/attributes/image never burn an
  // embedding call. (Comment区: title_emb_input / summary_emb_input / ... are the
  // exact strings that were embedded last time.)
  const { data: prev } = await supabase
    .from("ja_insights")
    .select(
      "title_embedding, summary_embedding, attributes_embedding, image_embedding, " +
        "title_emb_input, summary_emb_input, attributes_emb_input, image_emb_input",
    )
    .eq("report_date", input.report_date)
    .eq("report_id", input.report_id)
    .maybeSingle();
  const desired: Record<string, string> = {
    title: fieldInputs.title,
    summary: fieldInputs.summary,
    attributes: fieldInputs.attributes,
    image: imageEmbInput,
  };
  const prevRow = (prev ?? null) as unknown as Record<string, unknown> | null;
  const vecByKey: Record<string, number[] | null> = {};
  const toEmbed: string[] = [];
  for (const key of ["title", "summary", "attributes", "image"]) {
    if (!desired[key] || !desired[key].trim()) {
      vecByKey[key] = null;
      continue;
    }
    const prevInput = prevRow ? (prevRow[`${key}_emb_input`] as string | null) : null;
    const prevVec = prevRow ? (prevRow[`${key}_embedding`] as number[] | null) : null;
    if (prevVec && prevInput === desired[key]) {
      vecByKey[key] = prevVec; // unchanged → reuse the stored vector (no re-embed)
    } else {
      toEmbed.push(key);
    }
  }
  if (toEmbed.length) {
    const vectors = await embedMany(toEmbed.map((k) => desired[k]));
    toEmbed.forEach((k, i) => (vecByKey[k] = vectors[i]));
  }

  const row = {
    report_id: input.report_id,
    report_date: input.report_date,
    access,
    attributes: input.attributes ?? {},
    category: input.category ?? null,
    status: input.status ?? null,
    type: input.type ?? null,
    creator: input.creator ?? null,
    clients: input.clients ?? null,
    tracks: input.tracks ?? null,
    title_en: input.title_en,
    title_zh: input.title_zh ?? null,
    summary_en: input.summary_en,
    summary_zh: input.summary_zh ?? null,
    insight_en: input.insight_en ?? null,
    insight_zh: input.insight_zh ?? null,
    recommendations_en: input.recommendations_en ?? [],
    recommendations_zh: input.recommendations_zh ?? [],
    sources: input.sources ?? [],
    recommended_services_en: input.recommended_services_en ?? [],
    recommended_services_zh: input.recommended_services_zh ?? [],
    images,
    title_embedding: vecByKey.title ?? null,
    summary_embedding: vecByKey.summary ?? null,
    attributes_embedding: vecByKey.attributes ?? null,
    image_embedding: vecByKey.image ?? null,
    title_emb_input: fieldInputs.title || null,
    summary_emb_input: fieldInputs.summary || null,
    attributes_emb_input: fieldInputs.attributes || null,
    image_emb_input: imageEmbInput || null,
    embedded_at: new Date().toISOString(),
    created_by: createdBy ?? null,
  };

  const { data, error } = await supabase
    .from("ja_insights")
    .upsert(row, { onConflict: "report_date,report_id" })
    .select("id, report_id, report_date")
    .single();

  if (error) throw new Error(`insert insight failed: ${error.message}`);
  return data;
}

/** Delete a 实时洞察 by id (admin-gated in the HTTP layer). */
export async function deleteInsight(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("ja_insights")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`deleteInsight failed: ${error.message}`);
  return !!data;
}

// Upload + describe each image, returning the stored `images` rows and the
// combined description text to embed. A failed vision call doesn't abort the
// ingest — the image is still stored (caption is used as a fallback description).
async function processImages(
  inputs: ImageInput[],
): Promise<{ images: ImageRef[]; imageEmbInput: string }> {
  const images: ImageRef[] = [];
  const descriptions: string[] = [];

  for (const img of inputs) {
    let url = (img.url ?? "").trim();
    const data = (img.data ?? "").trim();
    if (data) url = (await uploadImage(data)).url; // base64 upload → public URL

    if (!url) continue; // nothing usable for this entry

    // Prefer the public URL for the vision call (works for every provider);
    // fall back to the inline data URL when only that was supplied.
    let description = "";
    try {
      description = await describeImage(url || data);
    } catch (e) {
      console.error(`describeImage failed for ${url}: ${(e as Error).message}`);
    }

    images.push({
      url,
      alt: img.alt ?? null,
      caption: img.caption ?? null,
      description: description || null,
    });
    if (description) descriptions.push(description);
    else if (img.caption) descriptions.push(img.caption);
  }

  return { images, imageEmbInput: descriptions.join("\n\n").trim() };
}
