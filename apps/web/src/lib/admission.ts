import { db, withTransaction, type Queryable } from '@/lib/db';

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

const IN_FLIGHT_STATUSES = ['queued', 'downloading', 'separating', 'extracting', 'uploading'];

const BLOCKED: AdmissionResult = { allowed: false, error_code: 'RATE_LIMITED' };
const ALLOWED: AdmissionResult = { allowed: true, error_code: null };

// Every admission counter below is a COUNT/SUM followed by a decision followed by an
// INSERT. Under READ COMMITTED a COUNT takes no lock on the rows it counted, so
// concurrent requests all read the same pre-burst totals and all decide "under the cap"
// — the per-IP limit's INSERT ... WHERE trick narrowed that window but did not close it,
// and the global in-flight / spend gates never had it at all (hardening review H2, H3).
//
// Serializing the whole check-and-insert on one transaction-scoped advisory lock closes
// all three at once. It has to be a SINGLE global lock, not per-IP: two of the three
// gates are global counters, so a per-IP lock would still let N different IPs race past
// the in-flight cap and the daily spend ceiling. At this app's scale (20 in-flight
// global, 5 jobs/min/IP) the critical section is a few millisecond-scale local queries,
// so serializing job creation costs nothing real.
const JOB_ADMISSION_LOCK = "hashtext('stem-loops:job-admission')";
const UPLOAD_RATE_LOCK_CLASS = "hashtext('stem-loops:upload-rate')";

// Bound the wait so a wedged transaction holding the lock can't pin a connection from a
// 3-connection pool until the function times out. Exceeding it raises 55P03, which the
// callers map to the same 429 "at capacity" response a real cap breach produces.
const LOCK_TIMEOUT = '5s';

/** True for Postgres 55P03 (lock_not_available) — i.e. we gave up waiting for the lock. */
export function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '55P03';
}

/**
 * Serialize this transaction against all other job admissions. Must be called first
 * inside the transaction that will also run checkAdmission() and the job INSERT.
 */
export async function lockJobAdmission(tx: Queryable): Promise<void> {
  await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await tx.query(`SELECT pg_advisory_xact_lock(${JOB_ADMISSION_LOCK})`);
}

/**
 * The three job-admission gates. Only meaningful while the caller holds the lock taken
 * by lockJobAdmission() — otherwise the counts are advisory at best.
 */
export async function checkAdmission(tx: Queryable, clientIpHash: string): Promise<AdmissionResult> {
  // 1. Per-client rolling window (parameterized interval — no SQL string interpolation).
  const recent = await tx.query(
    `SELECT COUNT(*)::int AS count FROM jobs
     WHERE client_ip_hash = $1
       AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [clientIpHash, RATE_WINDOW_MS],
  );
  if (recent.rows[0].count >= RATE_LIMIT) return BLOCKED;

  // 2. Global in-flight cap.
  const inFlight = await tx.query(
    `SELECT COUNT(*)::int AS count FROM jobs WHERE status = ANY($1)`,
    [IN_FLIGHT_STATUSES],
  );
  if (inFlight.rows[0].count >= MAX_IN_FLIGHT) return BLOCKED;

  // 3. Rolling 24h Replicate spend ceiling (cost_usd persisted to job_events.detail by the
  //    real pipeline in P2-12+; until then this sums to 0 and never trips in normal flow).
  const spend = await tx.query(
    `SELECT COALESCE(SUM((detail->>'cost_usd')::numeric), 0) AS total
     FROM job_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'`,
  );
  if (parseFloat(spend.rows[0].total) >= dailySpendCeilingUsd()) return BLOCKED;

  return ALLOWED;
}

// Per-IP rate limit for the presigned-upload endpoint. Counts recent presign requests
// for this client in a rolling window and only records a new one when under the cap, so
// a flood is refused (429) without unbounded table growth. Relies on the real client IP
// being resolved spoof-resistantly (client-ip.ts / BLOCKER #1) — otherwise it's keyed on
// a forgeable value.
//
// Unlike job admission this counter is purely per-IP, so it takes a per-IP advisory lock
// (two-argument form, a different lock space from the global job lock) rather than
// serializing every upload in the system behind one lock.
export async function checkUploadRate(clientIpHash: string): Promise<AdmissionResult> {
  return withTransaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.query(
      `SELECT pg_advisory_xact_lock(${UPLOAD_RATE_LOCK_CLASS}, hashtext($1))`,
      [clientIpHash],
    );
    const recent = await tx.query(
      `SELECT COUNT(*)::int AS count FROM upload_rate_events
       WHERE client_ip_hash = $1
         AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
      [clientIpHash, UPLOAD_RATE_WINDOW_MS],
    );
    if (recent.rows[0].count >= uploadRateLimit()) return BLOCKED;
    await tx.query(`INSERT INTO upload_rate_events (client_ip_hash) VALUES ($1)`, [clientIpHash]);
    return ALLOWED;
  });
}

// ── Upload-key binding (hardening review C1) ─────────────────────────────────────────
// A presigned upload key is a capability. Before this, /api/jobs accepted any uploadKey
// string a client sent, so learning someone else's key (GET /api/jobs/:id used to hand it
// out) was enough to have the worker reprocess their private audio and return the stems.
// upload_intents (migration 007) is the server-side record of what we actually minted.

/** Record that we minted a presigned PUT for `r2Key`, to be claimed once by `jobId`. */
export async function recordUploadIntent(
  jobId: string,
  r2Key: string,
  clientIpHash: string,
): Promise<void> {
  await db.query(
    `INSERT INTO upload_intents (job_id, r2_key, client_ip_hash) VALUES ($1, $2, $3)`,
    [jobId, r2Key, clientIpHash],
  );
}

/**
 * Claim the upload intent for this job. Returns false if no intent exists for exactly
 * this {jobId, r2Key} pair or it has already been consumed — i.e. the key was never
 * minted by us, belongs to a different job, or is being replayed.
 *
 * The UPDATE ... WHERE consumed_at IS NULL is the whole guarantee: Postgres row locking
 * makes the flag flip exactly once even under concurrent claims, so one upload can never
 * back two jobs. Must run in the same transaction as the job INSERT so a rejected or
 * failed insert releases the intent instead of burning it.
 */
export async function claimUploadIntent(
  tx: Queryable,
  jobId: string,
  r2Key: string,
): Promise<boolean> {
  const claimed = await tx.query(
    `UPDATE upload_intents SET consumed_at = NOW()
     WHERE job_id = $1 AND r2_key = $2 AND consumed_at IS NULL
     RETURNING job_id`,
    [jobId, r2Key],
  );
  return (claimed.rowCount ?? 0) > 0;
}
