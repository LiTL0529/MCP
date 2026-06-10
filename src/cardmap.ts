/**
 * Map a full insight (as returned by getInsight with lang="both") into the
 * "DailyCard" shape that the workbench's renderDailyCards() consumes verbatim.
 *
 * Field semantics mirror the demo's parseDailyMD output:
 *  - num/cat/status/clients are plain text
 *  - catLabel/hook/aud/sum/ins/rec (+ *En), imgs and src are pre-rendered HTML
 *  - tracks -> aud ("适用品牌赛道"), insight+recommendations -> ins
 *    ("前瞻建议"), recommended_services -> rec ("推荐产品服务"), sources -> src
 *  - summary/insight/recommendations bodies are Markdown, rendered to safe HTML
 *    via renderMarkdown so authored formatting shows in the workbench cards.
 */

import { renderInline, renderMarkdown } from "./mdrender.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline Markdown (bold/italic/code/links) for short, single-line fields. */
function inlineMd(s: unknown): string {
  return renderInline(esc(s));
}

function audHtml(tracks: unknown, en: boolean): string {
  const t = (tracks as string) || "";
  if (!t) return "";
  return `<b>${en ? "Applicable Tracks: " : "适用品牌赛道："}</b>${inlineMd(t)}`;
}

function srcHtml(sources: any[]): string {
  if (!Array.isArray(sources) || !sources.length) return "";
  return sources
    .map((s) => {
      let h = "";
      if (s?.tier) h += `<span class="tier">${esc(s.tier)}</span>`;
      if (s?.url) h += `<a href="${esc(s.url)}" target="_blank">${esc(s.title || s.url)}</a>`;
      else if (s?.title) h += esc(s.title);
      return h;
    })
    .filter(Boolean)
    .join("<br>");
}

function imgsHtml(images: any[]): string {
  if (!Array.isArray(images) || !images.length) return "";
  return images
    .map((im) => {
      const url = typeof im?.url === "string" && /^https?:\/\//i.test(im.url) ? im.url : "";
      if (!url) return "";
      const alt = esc(im?.alt || im?.caption || "");
      const cap = im?.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : "";
      return `<figure class="di-fig"><img src="${esc(url)}" alt="${alt}" loading="lazy">${cap}</figure>`;
    })
    .filter(Boolean)
    .join("");
}

function insHtml(insight: unknown, recs: unknown, en: boolean): string {
  let h = "";
  if (insight) h += renderMarkdown(insight as string);
  if (Array.isArray(recs)) {
    recs.forEach((r, i) => {
      h += `<p><b>${en ? `Rec ${i + 1}: ` : `建议 ${i + 1}：`}</b>${inlineMd(r)}</p>`;
    });
  }
  return h;
}

function recHtml(services: unknown, en: boolean): string {
  if (!Array.isArray(services) || !services.length) return "";
  return `<b>${en ? "Recommended Services: " : "推荐产品服务："}</b>${services.map((s) => inlineMd(s)).join(" · ")}`;
}

export interface DailyCard {
  num: string;
  cat: string;
  status: string;
  clients: string;
  catLabel: string;
  catLabelEn: string;
  hook: string;
  hookEn: string;
  aud: string;
  audEn: string;
  src: string;
  imgs: string;
  sum: string;
  sumEn: string;
  ins: string;
  insEn: string;
  rec: string;
  recEn: string;
}

export function toDailyCard(full: any): DailyCard {
  const attr = full.attributes || {};
  return {
    num: String(full.report_id ?? ""),
    cat: full.category || attr.category_zh || "",
    status: full.status || "",
    clients: full.clients || "",
    catLabel: esc(attr.category_zh || full.category || ""),
    catLabelEn: esc(attr.category_en || ""),
    hook: inlineMd(full.title?.zh || full.title?.en || ""),
    hookEn: inlineMd(full.title?.en || ""),
    aud: audHtml(attr.tracks_zh || full.tracks, false),
    audEn: audHtml(attr.tracks_en || full.tracks, true),
    src: srcHtml(full.sources),
    imgs: imgsHtml(full.images),
    sum: renderMarkdown(full.summary?.zh || full.summary?.en || ""),
    sumEn: renderMarkdown(full.summary?.en || ""),
    ins: insHtml(full.insight?.zh, full.recommendations?.zh, false),
    insEn: insHtml(full.insight?.en, full.recommendations?.en, true),
    rec: recHtml(full.recommended_services?.zh, false),
    recEn: recHtml(full.recommended_services?.en, true),
  };
}
