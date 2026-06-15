-- 0011_key_plain.sql — store the raw API key so the admin backend can re-copy
-- an existing token at any time.
--
-- SECURITY TRADE-OFF (chosen deliberately): the DB now holds USABLE secrets, not
-- just SHA-256 hashes. A DB dump/leak would expose live keys. The column is only
-- ever read back through the admin-gated /api/keys endpoint (the ja_api_keys
-- table itself is RLS-restricted / service-role only). Keys created BEFORE this
-- migration have key_plain = null and cannot be recovered — regenerate those.
-- Idempotent.
alter table ja_api_keys add column if not exists key_plain text;
