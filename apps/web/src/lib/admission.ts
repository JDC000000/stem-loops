import { db } from '@/lib/db';
import {
  ANON_JOB_DAILY_MSG,
  ANON_JOB_IN_FLIGHT_MSG,
  ANON_UPLOAD_DAILY_MSG,
  ERROR_COPY,
  RATE_LIMITED_PER_CLIENT_MSG,
  RATE_LIMITED_SPEND_CEILING_MSG,
} from '@/lib/error-copy';

// Admission control (PRD draft-2 hardening): three gates run BEFORE a job row is
// inserted or enqueued, so abuse and runaway spend are stopped at the door. The
// spend ceiling defends the <$30/mo Replicate hard cap.
export type AdmissionResult =
  | { allowed: true; error_code: null }
  // F72 (copy audit v1.3.1): one code, two causes. `reason` says which gate refused and
  // `message` is the sentence for that cause, so a user who did nothing wrong (the site-wide
  // spend ceiling) is never told they went too fast. The wire contract is unchanged: the
  // HTTP layer still answers 429 { error_code: 'RATE_LIMITED', message }.
  | { allowed: false; error_code: 'RATE_LIMITED'; reason: RateLimitReason; message: string }
  // B8: the GLOBAL in-flight cap is a different refusal from the per-client limit. The
  // user did nothing wrong — other people's songs fill the queue — so it gets its own
  // code, its own copy, and the HTTP layer answers 503 + Retry-After rather than 429.
  | { allowed: false; error_code: 'AT_CAPACITY'; retry_after_s: number; message: string };

export type RateLimitReason =
  | 'per_client'
  | 'spend_ceiling'
  | 'anon_job_in_flight'
  | 'anon_job_daily'
  | 'anon_upload_daily';

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 5; // per-client jobs per minute

// Global in-flight cap (B8). Default UNCHANGED at 20; ADMISSION_MAX_IN_FLIGHT overrides
// it so the cap can be raised or lowered without a deploy-time code change (e.g. when a
// second worker Machine is added). Anything that is not a plain positive integer falls
// back to the default and is logged ONCE per process — a typo must never turn into
// "cap = NaN" (every comparison false → no cap at all) or "cap = 0" (refuse everyone).
export const DEFAULT_MAX_IN_FLIGHT = 20;
let warnedBadMaxInFlight = false;
export function maxInFlight(): number {
  const raw = process.env.ADMISSION_MAX_IN_FLIGHT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_IN_FLIGHT;
  const t = raw.trim();
  const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  if (!warnedBadMaxInFlight) {
    warnedBadMaxInFlight = true;
    console.warn(
      `[admission] ADMISSION_MAX_IN_FLIGHT=${JSON.stringify(raw)} is not a positive integer; ` +
        `using the default ${DEFAULT_MAX_IN_FLIGHT}.`,
    );
  }
  return DEFAULT_MAX_IN_FLIGHT;
}

// Retry-After for an AT_CAPACITY refusal, in seconds. The worker is SERIAL (one Fly
// Machine, consumer.py poll_loop claims LIMIT 1 and runs it to completion), so a slot
// frees exactly when one job finishes. A typical job takes ~1–3 minutes end to end (the
// landing's own measured note: a 3:34 song took about 1–3 minutes), so the expected wait
// for the next free slot is about one job's duration. 120 s is the middle of that range:
// shorter would invite retries that land on a still-full queue, longer would turn people
// away for longer than the queue actually needs. It matches the copy ("a few minutes").
export const AT_CAPACITY_RETRY_AFTER_S = 120;

// Rolling 24h Replicate spend ceiling, in USD. Default 10; REPLICATE_SPEND_CEILING_USD
// overrides it. Guarded exactly like ADMISSION_MAX_IN_FLIGHT above: anything that is not a
// plain positive decimal ("ten", "$10", "1e3", "0", "-5") falls back to the default and is
// logged ONCE per process. It must never fail OPEN: a bare parseFloat turned a typo into
// NaN, `total >= NaN` is always false, and the ceiling silently stopped tripping.
// Blank / unset is the silent default.
export const DEFAULT_SPEND_CEILING_USD = 10;
let warnedBadSpendCeiling = false;
export function spendCeilingUsd(): number {
  const raw = process.env.REPLICATE_SPEND_CEILING_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SPEND_CEILING_USD;
  const t = raw.trim();
  const n = /^[0-9]+(\.[0-9]+)?$/.test(t) ? Number(t) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  if (!warnedBadSpendCeiling) {
    warnedBadSpendCeiling = true;
    console.warn(
      `[admission] REPLICATE_SPEND_CEILING_USD=${JSON.stringify(raw)} is not a positive number; ` +
        `using the default ${DEFAULT_SPEND_CEILING_USD}.`,
    );
  }
  return DEFAULT_SPEND_CEILING_USD;
}

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

export const IN_FLIGHT_STATUSES = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];

// ─── Signed-out jobs: per-IP caps (QA track B, B-03; PR #300 review MF-1, MF-2) ─────────
// Before these, the only per-visitor gate on a signed-out job was 5/min/IP. One script could
// fill the GLOBAL in-flight cap (20) in about four minutes, so every visitor got AT_CAPACITY,
// and a few IPs could burn the site-wide 24 h spend ceiling for everyone.
//
//   • in flight: at most ANON_JOB_MAX_IN_FLIGHT (2) non-terminal signed-out jobs per IP hash.
//     The worker is serial, so more than two queued from one visitor is only ever a queue
//     someone else waits behind.
//   • daily: at most ANON_JOB_DAILY_CAP (10) signed-out jobs per IP hash per rolling 24 h.
//
// EVERY signed-out job counts, link AND upload (MF-2: the first version filtered
// input_kind = 'youtube', so signed-out upload jobs had neither cap). Counted on the `jobs`
// rows themselves (client_ip_hash, created_at, status; index jobs_ip_hash_idx), so no new table.
//
// CONCURRENCY (MF-1). A single INSERT ... SELECT ... WHERE (count) < cap is NOT burst-safe
// under READ COMMITTED: concurrent statements each count from their own snapshot and never
// see each other's uncommitted rows (the review measured 20 parallel inserts -> 15 rows
// against a cap of 2). So every signed-out job INSERT runs in a transaction that FIRST takes
// lockAnonIp() — a transaction-scoped advisory lock on this IP hash — and only then runs the
// INSERT, whose statement snapshot is taken after the lock, so it sees every earlier insert
// from this IP. Different IPs never contend. Pinned by a real-Postgres parallel-burst test
// (test/anon-link-caps-db.test.mjs). checkAnonJobCaps() runs first only to pick the sentence.
// Signed-in users are unaffected: their caps are the plan's quota and burst limits.
// Env overrides are guarded like ADMISSION_MAX_IN_FLIGHT (a typo falls back to the default).
export const DEFAULT_ANON_JOB_MAX_IN_FLIGHT = 2;
export const DEFAULT_ANON_JOB_DAILY_CAP = 10;
const warnedAnonCap = new Set<string>();
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const t = raw.trim();
  const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  if (!warnedAnonCap.has(name)) {
    warnedAnonCap.add(name);
    console.warn(`[admission] ${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}.`);
  }
  return fallback;
}
export const anonJobMaxInFlight = () =>
  positiveIntEnv('ANON_JOB_MAX_IN_FLIGHT', DEFAULT_ANON_JOB_MAX_IN_FLIGHT);
export const anonJobDailyCap = () => positiveIntEnv('ANON_JOB_DAILY_CAP', DEFAULT_ANON_JOB_DAILY_CAP);

/**
 * SQL predicate for every signed-out job INSERT. `$ip`, `$statuses`, `$maxInFlight`, `$daily`
 * are the caller's placeholder numbers. Every signed-out row from this IP counts, any kind.
 * Only burst-safe inside a transaction that called lockAnonIp() first.
 */
export function anonJobCapsWhere(ip: string, statuses: string, maxInFlight: string, daily: string): string {
  return `(SELECT COUNT(*) FROM jobs WHERE client_ip_hash = ${ip} AND user_id IS NULL
            AND status = ANY(${statuses}::text[])) < ${maxInFlight}
          AND (SELECT COUNT(*) FROM jobs WHERE client_ip_hash = ${ip} AND user_id IS NULL
            AND created_at >= NOW() - INTERVAL '24 hours') < ${daily}`;
}

type TxClient = { query: (text: string, params?: unknown[]) => Promise<unknown> };

/**
 * Serialise every signed-out job INSERT from one IP hash (MF-1). Transaction-scoped: released
 * at COMMIT/ROLLBACK, so it is safe through a transaction-mode pooler. Call it as the FIRST
 * statement of the tx, then run the capped INSERT as a SEPARATE statement (a statement's
 * snapshot is taken when it starts, so a CTE inside the INSERT would still count stale rows).
 */
export async function lockAnonIp(client: TxClient, clientIpHash: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('anon-caps:' || $1, 0))`, [clientIpHash]);
}

/** Which anonymous job cap (if any) this IP is at. Advisory: the locked INSERT's WHERE decides. */
export async function checkAnonJobCaps(clientIpHash: string): Promise<AdmissionResult> {
  const r = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = ANY($2::text[]))::int AS in_flight,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS today
     FROM jobs
     WHERE client_ip_hash = $1 AND user_id IS NULL
       AND (status = ANY($2::text[]) OR created_at >= NOW() - INTERVAL '24 hours')`,
    [clientIpHash, IN_FLIGHT_STATUSES],
  );
  const row = r.rows[0] ?? { in_flight: 0, today: 0 };
  if (row.today >= anonJobDailyCap()) {
    return { allowed: false, error_code: 'RATE_LIMITED', reason: 'anon_job_daily', message: ANON_JOB_DAILY_MSG };
  }
  if (row.in_flight >= anonJobMaxInFlight()) {
    return {
      allowed: false,
      error_code: 'RATE_LIMITED',
      reason: 'anon_job_in_flight',
      message: ANON_JOB_IN_FLIGHT_MSG,
    };
  }
  return ALLOWED;
}

const BLOCKED: AdmissionResult = {
  allowed: false,
  error_code: 'RATE_LIMITED',
  reason: 'per_client',
  message: RATE_LIMITED_PER_CLIENT_MSG,
};
const SPEND_CEILING: AdmissionResult = {
  allowed: false,
  error_code: 'RATE_LIMITED',
  reason: 'spend_ceiling',
  message: RATE_LIMITED_SPEND_CEILING_MSG,
};
const ALLOWED: AdmissionResult = { allowed: true, error_code: null };
const AT_CAPACITY: AdmissionResult = {
  allowed: false,
  error_code: 'AT_CAPACITY',
  retry_after_s: AT_CAPACITY_RETRY_AFTER_S,
  message: `${ERROR_COPY.AT_CAPACITY.headline} ${ERROR_COPY.AT_CAPACITY.action}`,
};

/**
 * Global in-flight cap on its own (B8). Used by checkAdmission() below AND by
 * POST /api/uploads before it mints a presigned PUT, so a visitor is told the site is
 * full BEFORE they spend minutes uploading a file, not after (product-plan item 4.5).
 * Counts every job in a non-terminal status with no age bound: the worker is serial and
 * the reaper deliberately never touches `queued`, so a long queue is real load, not rot.
 */
export async function checkGlobalCapacity(): Promise<AdmissionResult> {
  const inFlight = await db.query(
    `SELECT COUNT(*)::int AS count FROM jobs WHERE status = ANY($1)`,
    [IN_FLIGHT_STATUSES],
  );
  return inFlight.rows[0].count >= maxInFlight() ? AT_CAPACITY : ALLOWED;
}

export async function checkAdmission(clientIpHash: string): Promise<AdmissionResult> {
  // 1. Per-client rolling window (parameterized interval — no SQL string interpolation).
  const recent = await db.query(
    `SELECT COUNT(*)::int AS count FROM jobs
     WHERE client_ip_hash = $1
       AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [clientIpHash, RATE_WINDOW_MS],
  );
  if (recent.rows[0].count >= RATE_LIMIT) return BLOCKED;

  // 2. Global in-flight cap — AT_CAPACITY, not RATE_LIMITED (B8): this refusal is about
  //    everyone else's jobs, so it must not tell this client they went too fast.
  const capacity = await checkGlobalCapacity();
  if (!capacity.allowed) return capacity;

  // 3. Rolling 24h Replicate spend ceiling (cost_usd persisted to job_events.detail by the
  //    real pipeline in P2-12+; until then this sums to 0 and never trips in normal flow).
  const spend = await db.query(
    `SELECT COALESCE(SUM((detail->>'cost_usd')::numeric), 0) AS total
     FROM job_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'`,
  );
  if (parseFloat(spend.rows[0].total) >= spendCeilingUsd()) return SPEND_CEILING;

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

// QA track B, B-05: a per-IP DAILY cap on presigned upload URLs minted for SIGNED-OUT callers.
// The per-minute limit alone allowed 10 x 200 MB PUTs a minute per IP (about 2.9 TB a day of
// R2 writes), none of them tied to a job, reaped only by the 24 h orphan sweep. Same table
// and atomic statement as the per-minute counter, under its own prefixed key and a 24 h
// window. upload_rate_events rows are kept 24 h by the worker sweep (cleanup.py
// UPLOAD_EVENT_RETENTION_SECONDS), which is exactly this window. 20 a day is ~4 GB at the
// 200 MB cap; a signed-out visitor who uploads more than 20 songs a day can sign in.
// Signed-in callers are not counted here: their jobs are metered by plan quota or credits.
export const DEFAULT_ANON_UPLOAD_DAILY_CAP = 20;
const ANON_UPLOAD_DAY_MS = 24 * 3600 * 1000;
export const anonUploadDailyCap = () =>
  positiveIntEnv('ANON_UPLOAD_DAILY_CAP', DEFAULT_ANON_UPLOAD_DAILY_CAP);
const anonUploadDayKey = (clientIpHash: string) => `uploads-day:${clientIpHash}`;
export async function checkAnonUploadDailyRate(clientIpHash: string): Promise<AdmissionResult> {
  const r = await rollingWindowAdmission(anonUploadDayKey(clientIpHash), ANON_UPLOAD_DAY_MS, anonUploadDailyCap());
  return r.allowed
    ? r
    : { allowed: false, error_code: 'RATE_LIMITED', reason: 'anon_upload_daily', message: ANON_UPLOAD_DAILY_MSG };
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

// Check-and-record for the upload_rate_events counters (per-minute presign, per-day anonymous
// presign, stems reads). The count and the insert are ONE statement, and since PR #300 review
// MF-1 that statement runs in a transaction AFTER a transaction-scoped advisory lock on the
// counter key. Without the lock a perfectly simultaneous burst overshot the limit by about the
// burst size under READ COMMITTED (each statement counts from its own snapshot); with it,
// requests for one key are serialised and each one's snapshot sees every earlier record.
// Different keys never contend. The INSERT ... SELECT records only while still under the cap
// (else 0 rows), so the table stays bounded.
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
  const res = (await db.tx(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('rate:' || $1, 0))`, [key]);
    return client.query(
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
  })) as { rowCount?: number | null };
  return (res.rowCount ?? 0) > 0 ? ALLOWED : BLOCKED;
}

// ─── Presign records for signed-out upload jobs (PR #300 review MF-2) ────────────────────
// POST /api/jobs only checked an upload key's FORMAT, so a signed-out caller could create
// upload jobs without ever calling POST /api/uploads, and the presign daily cap bounded
// nothing. Now, when POST /api/uploads mints a URL for a signed-out caller, it records
// `presign:<ipHash>:<jobId>` in upload_rate_events (same table, no migration; the worker
// sweep keeps rows 24 h), and the signed-out upload INSERT requires that record for the SAME
// IP hash and job id. A job id can be used once (jobs.id is the primary key).
export const presignRecordKey = (clientIpHash: string, jobId: string) => `presign:${clientIpHash}:${jobId}`;

export async function recordAnonPresign(clientIpHash: string, jobId: string): Promise<void> {
  await db.query(`INSERT INTO upload_rate_events (client_ip_hash) VALUES ($1)`, [
    presignRecordKey(clientIpHash, jobId),
  ]);
}

/** SQL predicate: this IP hash was issued this job id's upload URL within 24 h. */
export function anonPresignedWhere(key: string): string {
  return `EXISTS (SELECT 1 FROM upload_rate_events WHERE client_ip_hash = ${key}
            AND created_at >= NOW() - INTERVAL '24 hours')`;
}

/** Advisory pre-check for the user-facing sentence; the INSERT's WHERE decides. */
export async function hasAnonPresign(clientIpHash: string, jobId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM upload_rate_events WHERE client_ip_hash = $1
       AND created_at >= NOW() - INTERVAL '24 hours' LIMIT 1`,
    [presignRecordKey(clientIpHash, jobId)],
  );
  return (r.rowCount ?? 0) > 0;
}
