import { db } from '@/lib/db';

// Admission control (PRD draft-2 hardening): three gates run BEFORE a job row is
// inserted or enqueued, so abuse and runaway spend are stopped at the door. The
// spend ceiling defends the <$30/mo Replicate hard cap.
export type AdmissionResult =
  | { allowed: true; error_code: null }
  | { allowed: false; error_code: 'RATE_LIMITED' };

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 5; // per-client jobs per minute
const MAX_IN_FLIGHT = 20; // global in-flight cap
const dailySpendCeilingUsd = () => parseFloat(process.env.REPLICATE_SPEND_CEILING_USD ?? '10');

// Per-client presign minting cap for POST /api/uploads (security review BLOCKER #2).
// checkAdmission() can't cover this: it counts `jobs` rows, but an upload flood never
// creates a job — so uploads need their own per-IP counter (upload_rate_events, mig 005).
const UPLOAD_RATE_WINDOW_MS = 60_000;
const uploadRateLimit = () => Number.parseInt(process.env.UPLOAD_RATE_LIMIT ?? '10', 10) || 10;

// Per-client cap for GET /api/jobs/:id/stems (M-11 owner decision OD-B). Shares the
// upload_rate_events table and the same atomic check-and-record statement, under a
// PREFIXED key (see stemListRateKey) so the two counters are independent: playing
// along must never eat the budget a user needs to start their next job, and a stem
// flood must not be masked by an idle upload counter. The (client_ip_hash, created_at)
// index covers the prefixed key unchanged, so this needs no migration.
const STEM_LIST_RATE_WINDOW_MS = 60_000;

// 60 requests / minute / IP. Chosen from the real access pattern, not from the other
// limits: the player loads a job once and fetches its stem manifest once, and the
// signed URLs it gets back live 900 s, so even a long play-along session re-mints only
// a handful of times per hour per job. 60/min therefore leaves ~an order of magnitude
// of headroom over any legitimate human — someone opening a dozen jobs in a row, hard-
// reloading repeatedly, or sharing one NAT/CGNAT egress with a roomful of other users
// — which matters because this is the free, unauthenticated launch hook and a false
// 429 here breaks playback for a paying-adjacent user with no way to tell why.
//
// What it buys: each admitted request costs 1 DB query + 1 R2 ListObjectsV2, which is
// a BILLABLE Class A operation that nothing caches, + 6 offline signs. Unthrottled,
// one leaked done-job UUID made that unbounded. At 60/min a single IP is capped near
// 86k Class A ops/day instead, and the pool pressure is bounded with it.
//
// Deliberately NOT tied to UPLOAD_RATE_LIMIT (10/min) or RATE_LIMIT (5/min): those
// gate job CREATION, which is expensive and rare. Reading a manifest is cheap and
// routine, so copying their number would throttle normal playback.
const stemListRateLimit = () =>
  Number.parseInt(process.env.STEM_LIST_RATE_LIMIT ?? '60', 10) || 60;

/** Namespaces the stems counter inside the shared table. */
const stemListRateKey = (clientIpHash: string) => `stems:${clientIpHash}`;

const IN_FLIGHT_STATUSES = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];

const BLOCKED: AdmissionResult = { allowed: false, error_code: 'RATE_LIMITED' };
const ALLOWED: AdmissionResult = { allowed: true, error_code: null };

export async function checkAdmission(clientIpHash: string): Promise<AdmissionResult> {
  // 1. Per-client rolling window (parameterized interval — no SQL string interpolation).
  const recent = await db.query(
    `SELECT COUNT(*)::int AS count FROM jobs
     WHERE client_ip_hash = $1
       AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [clientIpHash, RATE_WINDOW_MS],
  );
  if (recent.rows[0].count >= RATE_LIMIT) return BLOCKED;

  // 2. Global in-flight cap.
  const inFlight = await db.query(
    `SELECT COUNT(*)::int AS count FROM jobs WHERE status = ANY($1)`,
    [IN_FLIGHT_STATUSES],
  );
  if (inFlight.rows[0].count >= MAX_IN_FLIGHT) return BLOCKED;

  // 3. Rolling 24h Replicate spend ceiling (cost_usd persisted to job_events.detail by the
  //    real pipeline in P2-12+; until then this sums to 0 and never trips in normal flow).
  const spend = await db.query(
    `SELECT COALESCE(SUM((detail->>'cost_usd')::numeric), 0) AS total
     FROM job_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'`,
  );
  if (parseFloat(spend.rows[0].total) >= dailySpendCeilingUsd()) return BLOCKED;

  return ALLOWED;
}

// Per-IP rate limit for the presigned-upload endpoint. Counts recent presign requests
// for this client in a rolling window and only records a new one when under the cap, so
// a flood is refused (429) without unbounded table growth. The statement itself now
// lives in rollingWindowAdmission() below, shared with the stems-route limiter;
// behaviour here is unchanged (same table, same window, same UPLOAD_RATE_LIMIT, and an
// unprefixed key so existing rows keep counting).
export async function checkUploadRate(clientIpHash: string): Promise<AdmissionResult> {
  return rollingWindowAdmission(clientIpHash, UPLOAD_RATE_WINDOW_MS, uploadRateLimit());
}

// Per-IP rate limit for GET /api/jobs/:id/stems (M-11 owner decision OD-B). Same
// mechanism, separate counter — see stemListRateKey / stemListRateLimit above for the
// key namespacing and for why the number is 60/min rather than the upload route's 10.
export async function checkStemListRate(clientIpHash: string): Promise<AdmissionResult> {
  return rollingWindowAdmission(
    stemListRateKey(clientIpHash),
    STEM_LIST_RATE_WINDOW_MS,
    stemListRateLimit(),
  );
}

// Atomic check-and-record (QA P0/P1): the count and the insert are ONE statement, so a
// request can't pass the check in the gap before it records its own event — the old
// two-round-trip TOCTOU where a concurrent burst all saw "under limit" then all inserted
// unconditionally. The INSERT ... SELECT records only while still under the cap (else 0
// rows). This fully serializes STAGGERED requests (each sees prior commits); a perfectly-
// simultaneous burst can still overshoot by ~the burst size under READ COMMITTED — a fully
// race-proof version would need a per-IP advisory lock or an atomic counter row (see report).
//
// Relies on the real client IP being resolved spoof-resistantly (client-ip.ts /
// BLOCKER #1) — otherwise it's keyed on a forgeable value. `key` is whatever the
// caller namespaces its counter with, so two callers sharing this table do not share
// a budget. Throws on a DB fault rather than returning ALLOWED: the callers wrap this
// in their own try/catch and turn it into a 5xx, which fails CLOSED.
async function rollingWindowAdmission(
  key: string,
  windowMs: number,
  limit: number,
): Promise<AdmissionResult> {
  const res = await db.query(
    `INSERT INTO upload_rate_events (client_ip_hash)
     SELECT $1::text
     WHERE (
       SELECT COUNT(*) FROM upload_rate_events
       WHERE client_ip_hash = $1
         AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')
     ) < $3
     RETURNING id`,
    [key, windowMs, limit],
  );
  return (res.rowCount ?? 0) > 0 ? ALLOWED : BLOCKED;
}
