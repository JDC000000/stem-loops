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
// a flood is refused (429) without unbounded table growth. Relies on the real client IP
// being resolved spoof-resistantly (client-ip.ts / BLOCKER #1) — otherwise it's keyed on
// a forgeable value.
export async function checkUploadRate(clientIpHash: string): Promise<AdmissionResult> {
  // Atomic check-and-record (QA P0/P1): the count and the insert are ONE statement, so a
  // request can't pass the check in the gap before it records its own event — the old
  // two-round-trip TOCTOU where a concurrent burst all saw "under limit" then all inserted
  // unconditionally. The INSERT ... SELECT records only while still under the cap (else 0
  // rows). This fully serializes STAGGERED requests (each sees prior commits); a perfectly-
  // simultaneous burst can still overshoot by ~the burst size under READ COMMITTED — a fully
  // race-proof version would need a per-IP advisory lock or an atomic counter row (see report).
  const res = await db.query(
    `INSERT INTO upload_rate_events (client_ip_hash)
     SELECT $1::text
     WHERE (
       SELECT COUNT(*) FROM upload_rate_events
       WHERE client_ip_hash = $1
         AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')
     ) < $3
     RETURNING id`,
    [clientIpHash, UPLOAD_RATE_WINDOW_MS, uploadRateLimit()],
  );
  return (res.rowCount ?? 0) > 0 ? ALLOWED : BLOCKED;
}
