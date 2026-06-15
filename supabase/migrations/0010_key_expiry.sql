-- 0010_key_expiry.sql — optional expiry for static API keys.
--
-- Lets admins mint time-limited keys from the admin backend and lets
-- resolveApiKey reject keys past their expiry (in addition to the existing
-- `revoked` flag, which is an immediate manual kill switch). Idempotent.
alter table ja_api_keys add column if not exists expires_at timestamptz;
