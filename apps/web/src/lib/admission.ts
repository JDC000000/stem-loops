import { db } from '@/lib/db';

// Admission control (PRD draft-2 hardening): three gates run BEFORE a job row is
// inserted or enqueued, so abuse and runaway spend are stopped at the door. The
// spend ceiling defends the <$30/mo Replicate hard cap.
export type AdmissionResult =
  | { allowed: true; error_code: null }
  | { allowed: false; error_code: 'RATE_LIMITED' };

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5; // per-client jobs per minute
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
  const recent = await db.query(
    `SELECT COUNT(*)::int AS count FROM upload_rate_events
     WHERE client_ip_hash = $1
       AND created_at >= NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [clientIpHash, UPLOAD_RATE_WINDOW_MS],
  );
  if (recent.rows[0].count >= uploadRateLimit()) return BLOCKED;

  await db.query(`INSERT INTO upload_rate_events (client_ip_hash) VALUES ($1)`, [clientIpHash]);
  return ALLOWED;
}
