// Retention policy: jobs and their files are deleted 24 hours after creation.
// Enforced by the worker's retention sweep (apps/worker/src/worker/cleanup.py) and
// jobs.expires_at (migration 007). Keep this constant in sync with those.
// Erasable-syntax only (no enums/param-properties) so node's type-stripping can run its test.

export const RETENTION_HOURS = 24;
export const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
export const RETENTION_SEC = RETENTION_MS / 1000;

// Floor so a presign for a job seconds from expiry is still a valid positive TTL.
const MIN_PRESIGN_SEC = 60;

/**
 * Presigned-download TTL for a job: 24h, but never past the job's own expires_at — a URL
 * minted at hour 23 must not outlive the objects it points at. `expiresAt` is the
 * jobs.expires_at value (Date, ISO string, or null/invalid → full window, capped at 24h).
 */
export function presignTtlSec(expiresAt: Date | string | null | undefined, nowMs: number = Date.now()): number {
  if (expiresAt == null) return RETENTION_SEC;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return RETENTION_SEC;
  const remaining = Math.floor((t - nowMs) / 1000);
  return Math.min(RETENTION_SEC, Math.max(MIN_PRESIGN_SEC, remaining));
}

/** "in 5 hours" / "in 12 minutes" / "in under a minute" / "expired". */
export function formatExpiresIn(expiresAtMs: number, nowMs: number = Date.now()): string {
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  return `in ${h} hour${h === 1 ? '' : 's'}`;
}
