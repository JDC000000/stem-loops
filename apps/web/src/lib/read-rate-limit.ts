// Per-IP limiter for anonymous-capable job READS (QA track B, B-11):
// GET /api/jobs/:id, GET /api/jobs/:id/play-chords, GET /api/jobs/:id/loops.
//
// Those routes run JOB_RETAINED_UNTIL_SQL (a correlated subquery on subscriptions) for any
// well-formed UUID, signed in or not, and had no limiter: a random-UUID flood went straight
// to the pool. This one runs BEFORE the database is touched.
//
// Deliberately NOT the DB-backed limiter the stems route uses (lib/admission.ts
// rollingWindowAdmission): that one INSERTs a row per request, and the job page polls
// GET /api/jobs/:id every few seconds. A write per poll is the pressure this exists to
// prevent. So it is an in-process fixed window. That is a per-INSTANCE cap: on Vercel several
// instances can each admit the limit, so it bounds a single client's rate per instance, not
// globally. A platform rule (Vercel WAF rate limit on /api/jobs/*) is the global fix and is
// recorded as residue in the PR. Keyed on every caller's IP hash, signed in or not: the
// session cookie is attacker-controlled, so exempting "signed-in" requests would exempt
// anyone who sends a cookie.
//
// Limit: JOB_READ_RATE_LIMIT per 60 s per IP hash per instance, default 180. The player polls
// about every 2-3 s (20-30/min per open tab); 180 leaves room for several tabs, reloads and a
// shared NAT before a human ever sees a 429, and still cuts a scripted flood to 3/s/instance.
//
// Pure and import-free so route tests can load it through a data-URL transpile.

export const JOB_READ_WINDOW_MS = 60_000;
export const DEFAULT_JOB_READ_RATE_LIMIT = 180;
// Bound memory under a flood of distinct keys: past this, expired windows are dropped, and if
// that is not enough the oldest entries go (Map iteration is insertion order).
const MAX_KEYS = 10_000;

type Window = { start: number; count: number };
const windows = new Map<string, Window>();

export function jobReadRateLimit(): number {
  const raw = process.env.JOB_READ_RATE_LIMIT;
  const t = raw?.trim() ?? '';
  const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_JOB_READ_RATE_LIMIT;
}

function prune(now: number): void {
  windows.forEach((w, k) => {
    if (now - w.start >= JOB_READ_WINDOW_MS) windows.delete(k);
  });
  while (windows.size >= MAX_KEYS) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) break;
    windows.delete(oldest);
  }
}

/** True when this read is admitted (and counted); false when the key is over its limit. */
export function admitJobRead(key: string, now: number = Date.now()): boolean {
  let w = windows.get(key);
  if (!w || now - w.start >= JOB_READ_WINDOW_MS) {
    if (!w && windows.size >= MAX_KEYS) prune(now);
    w = { start: now, count: 0 };
    windows.delete(key);
    windows.set(key, w);
  }
  if (w.count >= jobReadRateLimit()) return false;
  w.count += 1;
  return true;
}

/** Seconds until this key's window resets (for Retry-After). */
export function jobReadRetryAfterSec(key: string, now: number = Date.now()): number {
  const w = windows.get(key);
  if (!w) return 1;
  return Math.max(1, Math.ceil((w.start + JOB_READ_WINDOW_MS - now) / 1000));
}

/** Test hook: forget every window. */
export function _resetJobReadWindows(): void {
  windows.clear();
}
