-- 0014_community_files.sql — attachments for 需求社区 posts.
--
-- Adds a public Storage bucket for post files (md / html / pdf / …) and an
-- attachments column on posts holding [{name, url, type, size}]. The server
-- uploads with the service role (bypasses storage RLS); public=true makes the
-- returned URLs downloadable without auth. Idempotent.

insert into storage.buckets (id, name, public)
values ('ja-community-files', 'ja-community-files', true)
on conflict (id) do update set public = true;

alter table ja_community_posts
  add column if not exists attachments jsonb not null default '[]'::jsonb;
