/**
 * Embed every insight that is missing its per-field vectors.
 *
 *   npm run backfill
 *   npm run backfill -- --all     # re-embed everything (after a schema/model change)
 *
 * Each article gets THREE vectors: title / summary / attributes.
 */
import { supabase } from "../src/supabase.js";
import { buildFieldInputs, embedMany } from "../src/embeddings.js";

const reembedAll = process.argv.includes("--all");

async function main() {
  let query = supabase
    .from("ja_insights")
    .select(
      "id, report_id, report_date, access, attributes, category, status, type, clients, tracks, title_en, summary_en, title_embedding",
    )
    .order("report_date", { ascending: true });

  if (!reembedAll) query = query.is("title_embedding", null);

  const { data, error } = await query;
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("Nothing to embed. ✅");
    process.exit(0);
  }

  console.log(`Embedding ${data.length} insight(s) × 3 fields…`);
  let ok = 0;
  for (const row of data as any[]) {
    const inputs = buildFieldInputs({
      titleEn: row.title_en,
      summaryEn: row.summary_en,
      attributes: row.attributes ?? {},
      category: row.category,
      status: row.status,
      type: row.type,
      clients: row.clients,
      tracks: row.tracks,
      reportDate: row.report_date,
      access: row.access,
    });
    const fields = (["title", "summary", "attributes"] as const)
      .map((key) => ({ key, text: inputs[key] }))
      .filter((f) => f.text.trim().length > 0);
    try {
      const vectors = await embedMany(fields.map((f) => f.text));
      const vecByKey: Record<string, number[]> = {};
      fields.forEach((f, i) => (vecByKey[f.key] = vectors[i]));
      const { error: upErr } = await supabase
        .from("ja_insights")
        .update({
          title_embedding: vecByKey.title ?? null,
          summary_embedding: vecByKey.summary ?? null,
          attributes_embedding: vecByKey.attributes ?? null,
          title_emb_input: inputs.title || null,
          summary_emb_input: inputs.summary || null,
          attributes_emb_input: inputs.attributes || null,
          embedded_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
      ok++;
      console.log(`  ✓ ${row.report_date} / ${row.report_id}`);
    } catch (e) {
      console.error(`  ✗ ${row.report_date} / ${row.report_id}: ${(e as Error).message}`);
    }
  }
  console.log(`Done. ${ok}/${data.length} embedded.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
