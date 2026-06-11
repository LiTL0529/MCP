import { Pool } from "pg";
import { config } from "./config.js";

// ── Read-only SQL surface for the `run_sql` MCP tool ───────────────────────
// A dedicated, low-privilege Postgres connection that logs in as the `ja_reader`
// role (see migration 0006). That role:
//   • has SELECT on the non-embedding columns of the queryable tables and nothing else,
//   • is default_transaction_read_only = on  → it physically cannot write,
//   • is NOT the service role / table owner → Row-Level Security applies to it,
//     so ja_can_access filters every row by the caller's groups, even across JOINs.
// The caller's (groups, is_admin) are injected per-transaction via the GUCs the
// RLS policy reads. They come from the authenticated API key in the Node layer —
// NEVER from tool arguments or the SQL text. This is why agent-written SQL can be
// run safely: the agent decides WHAT to query, the database decides WHO sees WHAT.

export const isSqlEnabled = Boolean(config.readonlyDatabaseUrl);

let pool: Pool | null = null;
function getPool(): Pool {
  if (!config.readonlyDatabaseUrl) {
    throw new Error("run_sql is disabled: set SUPABASE_READONLY_URL (a DSN for the ja_reader role).");
  }
  if (!pool) {
    const url = config.readonlyDatabaseUrl;
    const isLocal = /@(?:localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new Pool({
      connectionString: url,
      // Supabase requires TLS; local dev usually doesn't. Honour an explicit
      // sslmode=disable in the URL by treating localhost as the no-TLS case.
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/**
 * Reject anything that isn't a single read-only statement. This is
 * defense-in-depth only — the real boundary is the ja_reader role (no write
 * grants + default read-only transaction + RLS). A `;` inside a string literal
 * is conservatively rejected; that's an acceptable trade for a tight surface.
 */
function assertSingleReadOnly(sql: string): string {
  const inner = sql.trim().replace(/;+\s*$/, ""); // drop a trailing semicolon
  if (!inner) throw new Error("Empty query.");
  if (inner.includes(";")) throw new Error("Only a single statement is allowed (no ';').");
  if (!/^(?:with|select)\b/i.test(inner)) {
    throw new Error("Only read-only SELECT / WITH queries are allowed.");
  }
  return inner;
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
}

/**
 * Run one read-only query as ja_reader, with the caller's identity bound to the
 * transaction so RLS filters every row. Hard-caps rows and execution time.
 */
export async function runReadonlySql(
  sql: string,
  groups: string[],
  isAdmin: boolean,
): Promise<SqlResult> {
  const inner = assertSingleReadOnly(sql);
  const maxRows = Number.isFinite(config.sqlMaxRows) ? Math.max(1, Math.floor(config.sqlMaxRows)) : 1000;
  const timeoutMs = Number.isFinite(config.sqlTimeoutMs) ? Math.max(1, Math.floor(config.sqlTimeoutMs)) : 5000;

  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query(`set local statement_timeout = ${timeoutMs}`);
    // Caller identity for the RLS policy. Parameterised → groups can't inject.
    await client.query("select set_config('ja.groups', $1, true)", [groups.join(",")]);
    await client.query("select set_config('ja.is_admin', $1, true)", [isAdmin ? "true" : "false"]);

    // Wrap so we can hard-cap rows regardless of the caller's query, and so a
    // sneaked-in non-SELECT collapses into a plain syntax error. Fetch one extra
    // row to detect truncation.
    const res = await client.query(`select * from (${inner}) _q limit ${maxRows + 1}`);
    const truncated = res.rows.length > maxRows;
    const rows = (truncated ? res.rows.slice(0, maxRows) : res.rows) as Record<string, unknown>[];
    return {
      columns: res.fields.map((f) => f.name),
      rows,
      row_count: rows.length,
      truncated,
    };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/**
 * Live schema for the run_sql skill / `schema://ja-insights` resource, read
 * straight from the catalog so it can never drift from the real columns.
 * Embedding/vector and internal *_emb_input columns are omitted (they aren't
 * granted to ja_reader anyway).
 */
export async function introspectSchema(tables: string[]): Promise<string> {
  const { rows } = await getPool().query(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1)
        and column_name not like '%\\_embedding'
        and column_name not like '%\\_emb\\_input'
        and udt_name <> 'vector'
      order by table_name, ordinal_position`,
    [tables],
  );
  const byTable = new Map<string, string[]>();
  for (const r of rows as { table_name: string; column_name: string; data_type: string; is_nullable: string }[]) {
    const line = `  ${r.column_name} ${r.data_type}${r.is_nullable === "NO" ? " not null" : ""}`;
    const cols = byTable.get(r.table_name) ?? [];
    cols.push(line);
    byTable.set(r.table_name, cols);
  }
  if (byTable.size === 0) return "-- (no queryable tables found / not granted to ja_reader)";
  return [...byTable.entries()]
    .map(([t, cols]) => `table ${t} (\n${cols.join(",\n")}\n);`)
    .join("\n\n");
}
