-- 0008_oauth.sql — MCP OAuth 2.1 Authorization Server state.
--
-- The MCP server doubles as its own OAuth Authorization Server so that any MCP
-- client (Claude Code, Claude.ai, etc.) can connect with just the server URL:
-- the client does Dynamic Client Registration + the PKCE auth-code flow, the
-- user logs in once in the browser with their portal account, and the client
-- receives a bearer token. No static API key to copy around.
--
-- Identity still comes from the portal (Supabase Auth) — see src/auth.ts. These
-- tables only hold OAuth protocol state (clients, short-lived auth codes, and
-- issued access/refresh tokens), with a snapshot of the resolved identity so
-- token verification is a single indexed lookup.
--
-- All three tables are service-role-only: RLS is enabled with NO policies, so
-- every non-service connection is denied. The Node server reaches them with the
-- service role (which bypasses RLS), exactly like ja_api_keys / ja_users.

-- Registered OAuth clients (Dynamic Client Registration, RFC 7591). Public
-- clients (PKCE, no secret) are the norm for MCP; client_secret stays null.
create table if not exists ja_oauth_clients (
  client_id                  text primary key,
  client_secret              text,
  client_secret_expires_at   bigint,                 -- epoch seconds; null/0 = no expiry
  client_id_issued_at        bigint,
  client_name                text,
  redirect_uris              jsonb not null default '[]'::jsonb,
  grant_types                jsonb,
  response_types             jsonb,
  scope                      text,
  token_endpoint_auth_method text default 'none',
  metadata                   jsonb not null default '{}'::jsonb,  -- full client info, verbatim
  created_at                 timestamptz not null default now()
);

-- Authorization codes: single-use, short-lived (minutes). `subject` is the
-- resolved identity snapshot captured at the /authorize step.
create table if not exists ja_oauth_codes (
  code_hash       text primary key,                  -- sha256(raw code)
  client_id       text not null,
  redirect_uri    text not null,
  code_challenge  text not null,                      -- PKCE S256 challenge
  scopes          jsonb not null default '[]'::jsonb,
  resource        text,                               -- RFC 8707 resource indicator
  subject         jsonb not null,                     -- { userId, email, name, isAdmin, seeAll, role }
  expires_at      timestamptz not null,
  consumed        boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists ja_oauth_codes_expires_idx on ja_oauth_codes (expires_at);

-- Issued tokens. One row per access token; refresh rotation updates the row.
create table if not exists ja_oauth_tokens (
  id                 uuid primary key default gen_random_uuid(),
  access_hash        text unique not null,            -- sha256(raw access token)
  refresh_hash       text unique,                     -- sha256(raw refresh token)
  client_id          text not null,
  subject            jsonb not null,
  scopes             jsonb not null default '[]'::jsonb,
  resource           text,
  expires_at         timestamptz not null,
  refresh_expires_at timestamptz,
  revoked            boolean not null default false,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz
);
create index if not exists ja_oauth_tokens_refresh_idx on ja_oauth_tokens (refresh_hash);

-- Deny-by-default: enable RLS, define no policies. Only the service role
-- (used by the Node server) can read/write these.
alter table ja_oauth_clients enable row level security;
alter table ja_oauth_codes   enable row level security;
alter table ja_oauth_tokens  enable row level security;
