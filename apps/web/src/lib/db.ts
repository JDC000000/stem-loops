import { Pool } from 'pg';

// Lazy singleton pool. Uses the pooled (pgbouncer) URL for serverless API routes,
// capped at 3 connections to stay within the Supabase free-tier limit.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL,
      max: 3,
    });
  }
  return pool;
}

export const db = {
  query: (text: string, params?: unknown[]) => getPool().query(text, params),
};
