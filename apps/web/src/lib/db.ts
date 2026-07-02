import { Pool } from 'pg';

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
    pool = new Pool({ connectionString: conn, max: 3, ssl: sslFor(conn) });
  }
  return pool;
}

export const db = {
  query: (text: string, params?: unknown[]) => getPool().query(text, params),
};
