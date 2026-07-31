// Per-IP throttle for GET /api/jobs/:id — the one endpoint the browser polls in a loop.
//
// Hardening review H5: every job/upload-creation route gates on admission, but the
// highest-frequency route had nothing, on an app whose entire Postgres pool is capped at
// 3 connections (lib/db.ts) and which issues three queries per poll. A tight loop from
// one client can starve the pool for everybody.
//
// Deliberately in-memory, NOT the DB-backed limiter the write paths use: the whole point
// is to spend fewer connections, and a limiter that writes a row per poll would be
// exactly the load it is meant to prevent. The trade-off is that each warm serverless
// instance counts separately, so the effective ceiling is (limit x instances) — fine for
// stopping an abusive loop, not a precise quota. The DB-backed gates on the write paths
// remain the real spend/abuse defence.
const WINDOW_MS = 60_000;

// A job page polls every 2s => 30/min per open tab. The default leaves room for several
// tabs and a page refresh mid-window while still cutting off a hot loop by orders of
// magnitude.
const pollLimit = () => Number.parseInt(process.env.JOB_POLL_RATE_LIMIT ?? '150', 10) || 150;

// Bounds memory if a client rotates source addresses. On overflow the map is cleared
// rather than refusing new keys: dropping counters fails open for a moment, refusing
// them would let one attacker lock every real user out.
const MAX_TRACKED_KEYS = 20_000;

type PollWindow = { count: number; resetAt: number };
const windows = new Map<string, PollWindow>();

function evictExpired(now: number): void {
  // Deleting during Map.forEach is well-defined; already-visited entries are unaffected.
  windows.forEach((w, key) => {
    if (w.resetAt <= now) windows.delete(key);
  });
  if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
}

/**
 * Record a poll from `key` and report whether it is within the per-window allowance.
 * Returns the seconds until the window resets so the caller can send Retry-After.
 */
export function allowPoll(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) evictExpired(now);
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  existing.count += 1;
  const allowed = existing.count <= pollLimit();
  return { allowed, retryAfterSec: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000) };
}

/** Test/reset hook — the module-level map is per-instance state. */
export function resetPollLimiter(): void {
  windows.clear();
}
