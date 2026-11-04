import { Pool, type QueryResultRow } from "pg";

function timeout(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 2_147_482_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147482647 (milliseconds)`);
  }
  return value;
}

const queryTimeoutMs = timeout("DB_QUERY_TIMEOUT_MS", 10_000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: timeout("DB_CONNECT_TIMEOUT_MS", 5_000),
  statement_timeout: queryTimeoutMs,
  query_timeout: queryTimeoutMs + 1_000,
});
let lastError: string | null = null;
let lastSuccessAt: string | null = null;
let failureVersion = 0;

function failed(event: string, error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
  failureVersion++;
  console.error(JSON.stringify({ event, service: "feed-generator", error: lastError }));
}

pool.on("error", (error: Error) => failed("database_pool_error", error));

export function getDatabaseHealth(): {
  status: "unknown" | "ok" | "degraded";
  lastError: string | null;
  lastSuccessAt: string | null;
} {
  return { status: lastError ? "degraded" : lastSuccessAt ? "ok" : "unknown", lastError, lastSuccessAt };
}

export async function query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
  const version = failureVersion;
  try {
    const result = values === undefined ? await pool.query<Row>(text) : await pool.query<Row>(text, values);
    if (version === failureVersion) lastError = null;
    lastSuccessAt = new Date().toISOString();
    return result;
  } catch (error) {
    failed("database_query_error", error);
    throw error;
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return getDatabaseHealth().status === "ok";
  } catch {
    // query() reports the failure and retains it for health reporting.
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
