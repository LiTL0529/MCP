-- 0017_settings.sql — global app settings (admin-managed), KV by key.
--
-- Holds the editable "洞察栏目分类" (insight category) list that 系统设置 manages
-- and that .md ingestion validates against. RLS deny-all; the Node app reads/
-- writes with the service role (reads are public-ish via API, writes admin-only
-- enforced in the app layer). Seeded with the categories that were previously
-- hard-coded in the frontend. Idempotent.

create table if not exists ja_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table ja_settings enable row level security;

insert into ja_settings (key, value) values
  ('insight_categories',
   '["新加坡院校","中国教育","东南亚竞争","SG本地","印度市场","AI&科技","AEO/GEO","品牌营销","小红书","跨境金融"]'::jsonb)
on conflict (key) do nothing;
