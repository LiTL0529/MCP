-- 月度洞察「我的反馈」 (per-user feedback on each monthly insight)
-- Ported from the old jeffery-insights public.insight_feedback model. One row
-- per (user, insight); upserted. Service-role only (RLS enabled, no policies);
-- the Node layer scopes reads/writes to the authenticated user.

create table if not exists ja_insight_feedback (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null,                  -- portal / ja_users id (or email)
  user_email        text,
  insight_ref       text not null,                  -- stable id of the 月度洞察 (library item)
  insight_title     text,                           -- snapshot, for admin reporting
  insight_category  text,                           -- snapshot
  used              boolean not null default false, -- 是否使用了这条洞察
  ways              text[] not null default '{}',   -- 使用方式 (客户提案/会议/月报…)
  client_name       text,                           -- 对应客户
  reaction          text,                           -- 客户反应
  client_feedback   text,                           -- 客户反馈
  tags              text[] not null default '{}',   -- 反馈标签
  note              text,                           -- 备注
  follow_up         boolean not null default false, -- 是否促成后续
  reason            text,                           -- 未使用原因
  suggest           text,                           -- 改进建议
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, insight_ref)
);

create index if not exists ja_insight_feedback_user_idx on ja_insight_feedback (user_id);

alter table ja_insight_feedback enable row level security;

drop trigger if exists ja_insight_feedback_set_updated_at on ja_insight_feedback;
create trigger ja_insight_feedback_set_updated_at
  before update on ja_insight_feedback
  for each row execute function ja_set_updated_at();
