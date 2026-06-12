-- 0009_comments.sql — user comments on insight articles.
--
-- Any authenticated caller may leave a comment on an insight they can access;
-- the comment is captured for ADMINS to review (regular users can post but not
-- read the list). Like the audit tables, this is service-role-only: RLS is
-- enabled with no policies, and the Node server enforces the rules in the app
-- layer (access check on write via the access-controlled get_insight RPC;
-- admin-only on read).
--
-- author_id is plain text (NOT a uuid FK): identities span two stores —
-- API-key users live in ja_users (uuid), portal/OAuth users carry a portal id —
-- so we keep the id as text and identify by author_email. Idempotent.

create table if not exists ja_insight_comments (
  id           uuid primary key default gen_random_uuid(),
  insight_id   uuid not null references ja_insights(id) on delete cascade,
  author_id    text,                 -- portal id or ja_users id, as text (no FK)
  author_email text not null,
  author_name  text,
  author_via   text,                 -- apikey | portal | oauth
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists ja_insight_comments_insight_idx on ja_insight_comments (insight_id, created_at desc);
create index if not exists ja_insight_comments_created_idx on ja_insight_comments (created_at desc);

alter table ja_insight_comments enable row level security;
