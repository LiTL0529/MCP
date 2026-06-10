/**
 * Bilingual JA-Research .md parser.
 *
 * Parses the example.md format — a Chinese block then an English block per
 * report id — into CreateInsightInput objects. Pure (no DB/embeddings), so it
 * can be reused by the CLI ingester and the /api/insights/from-md endpoint.
 */
import type { CreateInsightInput } from "./insights.js";
import type { SourceRef } from "./types.js";

const TITLE_RE = /^#{2,3}\s*(\d{4}-\d{2}-\d{2})\s*[/／]\s*([0-9A-Za-z]+)[\s　]+([\s\S]+)$/;

interface Article {
  lang: "en" | "zh";
  reportId: string;
  reportDate: string;
  title: string;
  meta: Record<string, string>;
  sections: Record<string, string>;
}

function splitArticles(md: string): string[] {
  const norm = md.replace(/\r\n?/g, "\n");
  // Article starts are the only #{2,3} headings that begin with a date.
  return norm.split(/\n(?=#{2,3}\s*\d{4}-\d{2}-\d{2}\s*[/／])/).filter((b) => TITLE_RE.test(b.trimStart()));
}

function parseArticle(block: string): Article | null {
  const lines = block.replace(/^\s+/, "").split("\n");
  const tm = lines[0].match(TITLE_RE);
  if (!tm) return null;
  const [, reportDate, reportId, title] = tm;

  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) break; // first section header
    const m = lines[i].match(/^\s*[-*]\s*([^:：]+)[:：]\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  }

  const rest = lines.slice(i).join("\n");
  const sections: Record<string, string> = {};
  rest.split(/\n(?=#{2,3}\s+\S)/).forEach((part) => {
    const sm = part.match(/^#{2,3}\s+([^\n]+)\n?([\s\S]*)$/);
    if (sm) sections[sm[1].trim()] = (sm[2] || "").trim();
  });

  const zhKeys = ["摘要", "洞察", "建议", "来源", "推荐服务"];
  const lang: "en" | "zh" = zhKeys.some((k) => k in sections) ? "zh" : "en";
  return { lang, reportId, reportDate, title: title.trim(), meta, sections };
}

function sec(a: Article | undefined, ...names: string[]): string {
  if (!a) return "";
  for (const n of names) if (a.sections[n]) return a.sections[n].trim();
  return "";
}

function metaVal(a: Article | undefined, ...keys: string[]): string {
  if (!a) return "";
  for (const k of keys) if (a.meta[k]) return a.meta[k].trim();
  return "";
}

function toListItems(body: string): string[] {
  if (!body) return [];
  // Numbered list (建议 / Recommendations) → split on leading "1." etc.
  if (/^\s*\d+[.、)]/.test(body)) {
    return body
      .split(/\n(?=\s*\d+[.、)]\s)/)
      .map((s) => s.replace(/^\s*\d+[.、)]\s*/, "").replace(/\n+/g, " ").trim())
      .filter(Boolean);
  }
  // Bullet list (推荐服务 / Recommended Services).
  return body
    .split("\n")
    .map((s) => s.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseSources(body: string): SourceRef[] {
  if (!body) return [];
  return body
    .split(/\n(?=[-*]\s)/)
    .map((entry) => entry.replace(/\n/g, " ").replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((ln) => {
      let tier = "";
      const tm = ln.match(/^\[([^\]]+)\]\s*/);
      if (tm) {
        tier = tm[1].replace(/级|Level\s*/gi, "").trim();
        ln = ln.slice(tm[0].length);
      }
      let url = "";
      const um = ln.match(/(https?:\/\/\S+)/);
      if (um) {
        url = um[1];
        ln = ln.replace(um[1], "");
      }
      return { tier, title: ln.replace(/[\s　]+$/, "").replace(/[:：]\s*$/, "").trim(), url };
    });
}

function paragraphs(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildInput(zh: Article | undefined, en: Article | undefined): CreateInsightInput {
  const any = (en ?? zh)!;
  const accessRaw = metaVal(en, "access") || metaVal(zh, "access");
  const access = accessRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "default");

  const categoryZh = metaVal(zh, "分类");
  const categoryEn = metaVal(en, "Category", "category");
  const clients = metaVal(en, "Relevant Clients", "相关客户") || metaVal(zh, "相关客户");
  const tracks = metaVal(en, "Applicable Tracks", "适用赛道") || metaVal(zh, "适用赛道");

  return {
    report_id: any.reportId,
    report_date: any.reportDate,
    access: access.length ? access : undefined,
    attributes: {
      date: any.reportDate,
      id: any.reportId,
      access: access.length ? access : ["default"],
      lang: "en",
      type: metaVal(en, "type") || metaVal(zh, "type") || null,
      category_en: categoryEn || null,
      category_zh: categoryZh || null,
      status: metaVal(en, "Status", "状态") || metaVal(zh, "状态") || null,
      clients_en: metaVal(en, "Relevant Clients") || null,
      clients_zh: metaVal(zh, "相关客户") || null,
      tracks_en: metaVal(en, "Applicable Tracks") || null,
      tracks_zh: metaVal(zh, "适用赛道") || null,
    },
    category: categoryZh || categoryEn || null,
    status: metaVal(en, "Status", "状态") || metaVal(zh, "状态") || null,
    type: metaVal(en, "type") || metaVal(zh, "type") || null,
    creator: metaVal(en, "creator") || metaVal(zh, "creator") || null,
    clients: clients || null,
    tracks: tracks || null,
    title_en: en?.title || zh?.title || "",
    title_zh: zh?.title || null,
    summary_en: paragraphs(sec(en, "Summary")) || paragraphs(sec(zh, "摘要")),
    summary_zh: paragraphs(sec(zh, "摘要")) || null,
    insight_en: paragraphs(sec(en, "Key Insights", "Insights")) || null,
    insight_zh: paragraphs(sec(zh, "洞察")) || null,
    recommendations_en: toListItems(sec(en, "Recommendations")),
    recommendations_zh: toListItems(sec(zh, "建议")),
    sources: parseSources(sec(en, "Sources") || sec(zh, "来源")),
    recommended_services_en: toListItems(sec(en, "Recommended Services")),
    recommended_services_zh: toListItems(sec(zh, "推荐服务")),
  };
}

/** Parse a bilingual .md document into one CreateInsightInput per report id. */
export function parseBilingualMd(md: string): CreateInsightInput[] {
  const articles = splitArticles(md)
    .map(parseArticle)
    .filter((a): a is Article => a !== null);

  const groups = new Map<string, { zh?: Article; en?: Article }>();
  for (const a of articles) {
    const g = groups.get(a.reportId) ?? {};
    g[a.lang] = a;
    groups.set(a.reportId, g);
  }

  const out: CreateInsightInput[] = [];
  for (const [, g] of groups) {
    const input = buildInput(g.zh, g.en);
    if (input.title_en && input.summary_en) out.push(input);
  }
  return out;
}
