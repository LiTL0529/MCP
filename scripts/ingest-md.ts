/**
 * Parse a bilingual JA-Research .md file (the example.md format: a Chinese
 * block then an English block per report id) and ingest each report.
 *
 *   npm run ingest-md -- "C:/path/to/example.md"
 *
 * Each report is embedded from its English title + key attributes + summary.
 */
import { readFile } from "node:fs/promises";
import { createInsight } from "../src/insights.js";
import { parseBilingualMd } from "../src/markdown.js";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run ingest-md -- "<path-to-.md>"');
    process.exit(1);
  }
  const md = await readFile(file, "utf8");
  const inputs = parseBilingualMd(md);

  if (!inputs.length) {
    console.error("No articles parsed. Expected '## <date> / <id> <title>' headings.");
    process.exit(1);
  }

  console.log(`Parsed ${inputs.length} report(s).`);
  let ok = 0;
  for (const input of inputs) {
    try {
      const created = await createInsight(input);
      ok++;
      console.log(`  ✓ ${created.report_date} / ${created.report_id} → ${created.id}`);
    } catch (e) {
      console.error(`  ✗ ${input.report_date} / ${input.report_id}: ${(e as Error).message}`);
    }
  }
  console.log(`Done. ${ok}/${inputs.length} ingested (with embeddings).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
