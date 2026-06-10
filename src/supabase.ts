import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Service-role client. The MCP server enforces access control itself
// (via the *_insights RPCs that take the caller's groups), so it runs
// with the service role and never relies on RLS for the read path.
export const supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    // Use Node's global fetch (undici) instead of supabase-js's bundled
    // node-fetch, so requests honour the global ProxyAgent set in config.ts.
    global: { fetch: (input: any, init?: any) => globalThis.fetch(input, init) },
  },
);
