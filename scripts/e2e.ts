/**
 * End-to-end check: provisions 3 users, backfills embeddings, then drives the
 * live MCP HTTP endpoint as a real client for each user to prove access control
 * + semantic search. Requires the server to be running on $PORT.
 *
 *   npm run dev            # in one terminal
 *   npx tsx scripts/e2e.ts # in another
 */
import { supabase } from "../src/supabase.js";
import { generateApiKey } from "../src/auth.js";
import { buildFieldInputs, embedMany } from "../src/embeddings.js";
import { config } from "../src/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = new URL(`http://localhost:${config.port}/mcp`);

async function ensureUser(email: string, name: string, groups: string[], isAdmin: boolean): Promise<string> {
  const { data: user, error } = await supabase
    .from("ja_users")
    .upsert({ email, name, access_groups: groups, is_admin: isAdmin }, { onConflict: "email" })
    .select("id")
    .single();
  if (error || !user) throw new Error(`ensureUser ${email}: ${error?.message}`);
  const { raw, hash, prefix } = generateApiKey();
  const { error: keyErr } = await supabase
    .from("ja_api_keys")
    .insert({ user_id: user.id, key_hash: hash, key_prefix: prefix, label: "e2e" });
  if (keyErr) throw new Error(`mint key ${email}: ${keyErr.message}`);
  return raw;
}

async function backfill(): Promise<number> {
  const { data, error } = await supabase
    .from("ja_insights")
    .select("id,title_en,summary_en,attributes,category,status,type,clients,tracks,report_date,access")
    .is("title_embedding", null);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as any[]) {
    const inputs = buildFieldInputs({
      titleEn: row.title_en,
      summaryEn: row.summary_en,
      attributes: row.attributes,
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
    const vectors = await embedMany(fields.map((f) => f.text));
    const vecByKey: Record<string, number[]> = {};
    fields.forEach((f, i) => (vecByKey[f.key] = vectors[i]));
    await supabase
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
  }
  return (data ?? []).length;
}

async function callTools(label: string, apiKey: string) {
  const transport = new StreamableHTTPClientTransport(BASE, {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(transport);

  const parse = (r: any) => JSON.parse(r.content[0].text);
  const who = parse(await client.callTool({ name: "whoami", arguments: {} }));
  const list = parse(await client.callTool({ name: "list_insights", arguments: { lang: "en" } }));
  const search = parse(
    await client.callTool({
      name: "search_insights",
      arguments: { query: "Chinese companies investing in Singapore, jobs for students", lang: "en", limit: 5 },
    }),
  );

  console.log(`\n=== ${label} (${who.email}, groups=[${who.access_groups}], admin=${who.is_admin}) ===`);
  console.log(`  list_insights : total=${list.total}, items=${list.items.length}`);
  console.log(`  search_insights: count=${search.count}`);
  if (search.items[0]) {
    const top = search.items[0];
    console.log(`    top: "${String(top.title.en).slice(0, 60)}…"  sim=${top.similarity}`);
    const full = parse(await client.callTool({ name: "get_insight", arguments: { id: top.id, lang: "both" } }));
    console.log(`  get_insight   : found=${full.found}, has_zh_title=${!!full.insight?.title?.zh}, recs=${full.insight?.recommendations?.en?.length}`);
  }
  await client.close();
  return { listTotal: list.total, searchCount: search.count };
}

async function main() {
  console.log("Provisioning users + keys…");
  const adminKey = await ensureUser("admin@jefferyasia.com", "JA Admin", [], true);
  const nusKey = await ensureUser("nus.user@nus.edu.sg", "NUS User", ["NUS"], false);
  const publicKey = await ensureUser("public.user@demo.com", "Public User", [], false);

  console.log("Backfilling embeddings…");
  const n = await backfill();
  console.log(`  embedded ${n} row(s) that were missing vectors.`);

  const admin = await callTools("ADMIN", adminKey);
  const nus = await callTools("NUS USER", nusKey);
  const pub = await callTools("PUBLIC-ONLY USER", publicKey);

  console.log("\n=== ACCESS-CONTROL ASSERTIONS ===");
  const seedIsRestricted = true; // example.md article: access {NUS,SMU,NTU}, not 'default'
  const checks: [string, boolean][] = [
    ["admin sees the restricted article", admin.searchCount >= 1],
    ["NUS user sees the restricted article (group match)", nus.searchCount >= 1],
    ["public-only user is BLOCKED from the restricted article", pub.searchCount === 0 && pub.listTotal === 0],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} — ${name}`);
    if (!ok) allPass = false;
  }
  console.log(`\n${allPass ? "🎉 ALL CHECKS PASSED" : "⚠️ SOME CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E error:", e);
  process.exit(1);
});
