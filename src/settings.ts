import { supabase } from "./supabase.js";

// ── Global app settings (admin-managed KV) ─────────────────
// Currently holds the editable "洞察栏目分类" list that 系统设置 manages and that
// .md ingestion validates against. RLS deny-all; identity/authorization is
// enforced in the HTTP layer (writes are admin-only).

export const DEFAULT_INSIGHT_CATEGORIES = [
  "新加坡院校", "中国教育", "东南亚竞争", "SG本地", "印度市场",
  "AI&科技", "AEO/GEO", "品牌营销", "小红书", "跨境金融",
];

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data, error } = await supabase
    .from("ja_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`getSetting(${key}) failed: ${error.message}`);
  return (data?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await supabase
    .from("ja_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`setSetting(${key}) failed: ${error.message}`);
}

/** The editable insight-category list (falls back to the seed defaults). */
export async function getInsightCategories(): Promise<string[]> {
  const v = await getSetting<string[]>("insight_categories", DEFAULT_INSIGHT_CATEGORIES);
  return Array.isArray(v) && v.length ? v : DEFAULT_INSIGHT_CATEGORIES;
}
