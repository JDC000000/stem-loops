import { Pool, QueryResult } from 'pg';

// Minimal query surface shared by the pool and a checked-out transaction client, so
// admission helpers can run either standalone or inside db.tx() without caring which.
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

// Supabase's pooler serves a cert not in Node's default CA bundle
// (SELF_SIGNED_CERT_IN_CHAIN), and node-pg now forces verification for sslmode=require
// — so for Supabase hosts connect over TLS but skip chain verification. A local/dev
// Postgres (no TLS) is left untouched so `make dev` still works.
export function sslFor(conn: string | undefined): { rejectUnauthorized: false } | undefined {
  return conn && /supabase\.(co|com)/.test(conn) ? { rejectUnauthorized: false } : undefined;
}

// Lazy singleton pool. Uses the pooled (pgbouncer) URL for serverless API routes,
// capped at 3 connections to stay within the Supabase free-tier limit.
//
// The env var is DATABASE_URL_POOLED. It was documented as DATABASE_POOL_URL in two
// places for a while (hardening review C3), so ops could set the "documented" name and
// silently get the direct, non-pgbouncer connection on every invocation — the exact
// free-tier exhaustion this exists to avoid. Falling back is still correct for local
// dev, but in production it is a misconfiguration, so say so loudly rather than
// degrading in silence.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const conn = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL;
    if (!process.env.DATABASE_URL_POOLED && process.env.NODE_ENV === 'production') {
      console.warn(
        '[db] DATABASE_URL_POOLED is not set — falling back to the DIRECT DATABASE_URL. ' +
          'Every serverless invocation will open a direct Postgres connection and the ' +
          'Supabase connection cap will be exhausted under load. Set DATABASE_URL_POOLED ' +
          'to the pooled (pgbouncer, port 6543) connection string.',
      );
    }
    pool = new Pool({ connectionString: conn, max: 3, ssl: sslFor(conn) });
  }
  return pool;
}

// Run `fn` inside a single BEGIN/COMMIT on one checked-out connection. Needed by the
// admission gates: their counters are read-then-act, so they only hold if the read, the
// decision and the INSERT are one transaction serialized by a transaction-scoped
// advisory lock (see lib/admission.ts).
//
// Only pg_advisory_XACT_lock is used, never the session-scoped variant — transaction
// locks are released at COMMIT/ROLLBACK and so remain correct under pgbouncer's
// transaction pooling. `fn` throwing rolls the whole thing back; returning normally
// commits, so admission rejections must be *returned*, not thrown, only when nothing
// durable should be undone.
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken — release() below discards it */
    }
    throw err;
  } finally {
    client.release();
  }
}

export const db: Queryable & { tx: typeof withTransaction } = {
  query: (text: string, params?: unknown[]) => getPool().query(text, params),
  tx: withTransaction,
};
