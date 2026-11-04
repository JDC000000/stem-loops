// Pure SSL-connection-string helpers. No `pg` import — kept separate from
// db.ts so these helpers can be unit-tested without pulling in the pg
// module (which has CJS/ESM quirks under node --experimental-strip-types).

// Supabase's pooler serves a cert not in Node's default CA bundle
// (SELF_SIGNED_CERT_IN_CHAIN), and node-pg + pg-connection-string v2.14 now
// treat `sslmode=require` in the URL as an alias for `verify-full` — which
// sets `rejectUnauthorized: true` from the URL side and can OVERRIDE an
// explicit `ssl: { rejectUnauthorized: false }` passed to new Pool(), depending
// on pg's merge order. So for Supabase hosts we:
//   (a) strip any `sslmode=*` query param from the connection string, and
//   (b) pass `ssl: { rejectUnauthorized: false }` as the single source of truth.
// This is safe for the Supabase pooler (traffic is still TLS-encrypted end to
// end; we just skip cert chain verification, which is the Supabase-recommended
// posture for pooler connections). A local/dev Postgres (no TLS) is left
// untouched so `make dev` still works.
export function sslFor(conn: string | undefined): { rejectUnauthorized: false } | undefined {
  return conn && /supabase\.(co|com)/.test(conn) ? { rejectUnauthorized: false } : undefined;
}

// Strip sslmode from the connection string so our explicit `ssl` config in
// new Pool() is the only source of TLS behavior. pg-connection-string v2.14+
// treats `sslmode=require` as verify-full, which clobbers rejectUnauthorized:
// false. Removing the URL param side-steps that merge ambiguity entirely.
// Non-Supabase URLs are returned unchanged.
export function sanitizeSupabaseConn(conn: string): string {
  if (!/supabase\.(co|com)/.test(conn)) return conn;
  try {
    const url = new URL(conn);
    url.searchParams.delete('sslmode');
    // Also drop uselibpqcompat if present — no longer needed with explicit ssl config.
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch {
    // Malformed URL — let pg produce its own error downstream so the operator
    // sees `ERR_INVALID_URL` rather than a silent swallow here.
    return conn;
  }
}
