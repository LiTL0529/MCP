-- 0018_key_scopes.sql — per-key capability scopes.
--
-- Adds a `scopes text[]` column to ja_api_keys so a key can be granted narrow
-- capabilities without full admin. Used by the public daily-insights API:
-- a key with scope 'query:daily' may read ANY registered user's date-scoped
-- daily insights (cross-user, server-to-server), while still NOT being able to
-- ingest/manage like an admin key. Empty array = no extra capabilities.
-- Idempotent.

alter table ja_api_keys
  add column if not exists scopes text[] not null default '{}';
