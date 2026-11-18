import * as Sentry from '@sentry/nextjs';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { sslFor, sanitizeSupabaseConn } from './db-ssl';

// Re-export so existing imports from '@/lib/db' keep working.
export { sslFor, sanitizeSupabaseConn };

// Lazy singleton pools. Both use the pooled (pgbouncer / Supavisor
// transaction-mode) URL for serverless API routes.
//
//   pool         shared by every page and API route; capped at 3 connections
//                to stay within the Supabase free-tier limit. Unchanged.
//   webhookPool  ONLY the Stripe webhook (PR #298 review R2-2). The webhook
//                holds a transaction across a Stripe read (per-subscription
//                advisory lock), so it must never take connections page loads
//                are waiting for. It is small, and it fails fast: a webhook
//                that cannot get a connection within WEBHOOK_POOL_CONNECT_TIMEOUT_MS
//                errors (500, Stripe retries) instead of queueing for ever.
//                Through the pooler URL these are pooler client slots, not
//                Postgres backends.
const SHARED_POOL_MAX = 3;
const WEBHOOK_POOL_MAX = 2;
const WEBHOOK_POOL_CONNECT_TIMEOUT_MS = 5000;

let pool: Pool | null = null;
let webhookPool: Pool | null = null;

function connString(): string {
  const conn = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL;
  // Without a connection string, `pg` silently falls back to PG* env vars and
  // localhost:5432 — on Vercel that surfaces as ECONNREFUSED far from the
  // real cause. Fail loudly so the missing env var is visible in logs.
  if (!conn) {
    throw new Error(
      'DATABASE_URL_POOLED (or DATABASE_URL) is not set — cannot create a Postgres pool.',
    );
  }
  return conn;
}

function getPool(): Pool {
  if (!pool) {
    const conn = connString();
    pool = new Pool({
      connectionString: sanitizeSupabaseConn(conn),
      max: SHARED_POOL_MAX,
      ssl: sslFor(conn),
    });
  }
  return pool;
}

function getWebhookPool(): Pool {
  if (!webhookPool) {
    const conn = connString();
    webhookPool = new Pool({
      connectionString: sanitizeSupabaseConn(conn),
      max: WEBHOOK_POOL_MAX,
      connectionTimeoutMillis: WEBHOOK_POOL_CONNECT_TIMEOUT_MS,
      ssl: sslFor(conn),
    });
  }
  return webhookPool;
}

type Query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<R>>;

function makeDb(get: () => Pool) {
  return {
    query: (<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
      get().query<R>(text, params)) as Query,

    /**
     * Run `fn` inside a single checked-out client, wrapped in BEGIN/COMMIT.
     * The client's `query` is passed to `fn`; any throw triggers ROLLBACK.
     * Used for advisory-lock-protected tx regions (e.g. billing checkout
     * rate limit) where READ COMMITTED alone can't serialize concurrent
     * requests. Advisory locks taken with pg_advisory_xact_lock release
     * automatically at COMMIT/ROLLBACK.
     */
    tx: async <T>(fn: (client: { query: Query }) => Promise<T>): Promise<T> => {
      const client: PoolClient = await get().connect();
      // PR #298 review R3-1. pg's Pool listens for 'error' only on IDLE
      // clients; a checked-out client that the server drops (e.g. an
      // idle_in_transaction_session_timeout while the webhook waits on
      // Stripe, or a pooler restart) emits 'error' with NO listener, which
      // Node turns into an uncaughtException that kills the instance. While
      // the client is ours, report the error instead; the next statement
      // then fails normally (the caller answers 500), and the broken client
      // is destroyed on release instead of going back to the pool.
      let broken: Error | null = null;
      const onError = (err: Error) => {
        // pg emits twice for one drop (the server's FATAL, then "Connection
        // terminated unexpectedly"): report the first, once per checkout.
        if (broken) return;
        broken = err;
        console.error('[db] checked-out client error:', err.message);
        try {
          Sentry.captureException(err, { tags: { component: 'db.tx' } });
        } catch {
          // never let reporting throw from an event handler
        }
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
            client.query<R>(text, params)) as Query,
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
        client.removeListener('error', onError);
        // release(err) destroys the client rather than pooling a dead one.
        client.release(broken ?? undefined);
      }
    },
  };
}

export const db = makeDb(getPool);

/** The Stripe webhook's own pool. Use it ONLY from api/billing/webhook. */
export const webhookDb = makeDb(getWebhookPool);
