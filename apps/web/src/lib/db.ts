import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// Supabase's pooler serves a cert not in Node's default CA bundle
// (SELF_SIGNED_CERT_IN_CHAIN), and node-pg now forces verification for sslmode=require
// — so for Supabase hosts connect over TLS but skip chain verification. A local/dev
// Postgres (no TLS) is left untouched so `make dev` still works.
export function sslFor(conn: string | undefined): { rejectUnauthorized: false } | undefined {
  return conn && /supabase\.(co|com)/.test(conn) ? { rejectUnauthorized: false } : undefined;
}

// Lazy singleton pool. Uses the pooled (pgbouncer) URL for serverless API routes,
// capped at 3 connections to stay within the Supabase free-tier limit.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const conn = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL;
    // Without a connection string, `pg` silently falls back to PG* env vars and
    // localhost:5432 — on Vercel that surfaces as ECONNREFUSED far from the
    // real cause. Fail loudly so the missing env var is visible in logs.
    if (!conn) {
      throw new Error(
        'DATABASE_URL_POOLED (or DATABASE_URL) is not set — cannot create a Postgres pool.',
      );
    }
    pool = new Pool({ connectionString: conn, max: 3, ssl: sslFor(conn) });
  }
  return pool;
}

export const db = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> => getPool().query<R>(text, params),

  /**
   * Run `fn` inside a single checked-out client, wrapped in BEGIN/COMMIT.
   * The client's `query` is passed to `fn`; any throw triggers ROLLBACK.
   * Used for advisory-lock-protected tx regions (e.g. billing checkout
   * rate limit) where READ COMMITTED alone can't serialize concurrent
   * requests. Advisory locks taken with pg_advisory_xact_lock release
   * automatically at COMMIT/ROLLBACK.
   */
  tx: async <T>(
    fn: (client: {
      query: <R extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[],
      ) => Promise<QueryResult<R>>;
    }) => Promise<T>,
  ): Promise<T> => {
    const client: PoolClient = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: <R extends QueryResultRow = QueryResultRow>(
          text: string,
          params?: unknown[],
        ) => client.query<R>(text, params),
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — original error wins
      }
      throw err;
    } finally {
      client.release();
    }
  },
};
