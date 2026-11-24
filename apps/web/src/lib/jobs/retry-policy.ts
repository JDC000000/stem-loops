// "Try again" on a failed song (#321; Phase B, B3). Which failed jobs get the button, as a
// pure function, so the GET (button shown?) and the POST (retry allowed?) of
// app/api/jobs/[id]/retry cannot disagree, and every cell is testable without I/O.
//
// Decided (brief B3; #321; Jon):
//   * Link songs only (Q-F). A failed UPLOAD gets "Upload again", never a retry: its source
//     file is deleted with the job's 24 h window, and a retry must not reuse its R2 key.
//   * Retryable codes are #321's list: the failure can go away on its own. Never retryable:
//     DOWNLOAD_INVALID_URL / DOWNLOAD_PRIVATE / DOWNLOAD_AGE_RESTRICTED — same result every
//     time. RATE_LIMITED is retryable after a cooldown. Every other code (EXTRACTION_FAILED,
//     the UPLOAD_* codes, an unknown code) gets no button.
//   * At most RETRY_CAP retries per original, read from jobs.retry_depth (migration 045) and
//     never from the retry_of chain, which the sweep breaks. A job is retried at most once
//     (jobs.retried_at).
//   * Owner only. An anonymous job (user_id NULL) and a demo song get no button, and the
//     caller is told "not found" exactly as GET /api/jobs/:id would tell a non-owner.
//   * No outage breaker (Q-A): nothing here reads a health or canary signal.
import { RETRY_CAP, mirrorRestoreCharge } from '@/lib/jobs/create-link-job';

export { RETRY_CAP, mirrorRestoreCharge };

/** #321 constraint 4: the failure is transient, so the same link may well work next time. */
export const RETRYABLE_CODES: readonly string[] = [
  'DOWNLOAD_BLOCKED',
  'DOWNLOAD_TIMEOUT',
  'FETCH_PROXY_FAILED',
  'SEPARATION_FAILED',
  'UPLOAD_FAILED',
  'INTERNAL_ERROR',
];

/** #321: the same result every time. Listed so the table test can pin them as refused. */
export const NEVER_RETRY_CODES: readonly string[] = [
  'DOWNLOAD_INVALID_URL',
  'DOWNLOAD_PRIVATE',
  'DOWNLOAD_AGE_RESTRICTED',
];

/** RATE_LIMITED: shown again only once this long has passed since the job last changed. */
export const RATE_LIMITED_COOLDOWN_S = 60;

/** The job columns the decision needs, straight from the row. */
export interface RetryCandidate {
  user_id: string | null | undefined;
  is_demo?: boolean | null;
  input_kind: string | null | undefined;
  status: string;
  error_code: string | null | undefined;
  retry_depth: number | null | undefined;
  retried_at: string | Date | null | undefined;
  updated_at: string | Date | null | undefined;
}

export type RetryDecision =
  | { kind: 'not_found' }
  | { kind: 'none' }
  | { kind: 'upload_again' }
  | { kind: 'already_retried' }
  | { kind: 'cap_reached' }
  | { kind: 'cooldown'; retry_after_s: number }
  | { kind: 'eligible'; retries_left: number };

export function decideRetry(job: RetryCandidate, callerId: string | null, nowMs: number = Date.now()): RetryDecision {
  // Owner only: a demo song, an anonymous job, someone else's job, or no session → not found.
  if (job.is_demo === true) return { kind: 'not_found' };
  if (callerId === null || typeof job.user_id !== 'string' || job.user_id !== callerId) return { kind: 'not_found' };
  if (job.status !== 'failed') return { kind: 'none' };
  if (job.input_kind === 'upload') return { kind: 'upload_again' };
  if (job.input_kind !== 'youtube') return { kind: 'none' };
  const code = job.error_code ?? '';
  const rateLimited = code === 'RATE_LIMITED';
  if (!rateLimited && !RETRYABLE_CODES.includes(code)) return { kind: 'none' };
  if (job.retried_at !== null && job.retried_at !== undefined) return { kind: 'already_retried' };
  const depth = Number(job.retry_depth ?? 0);
  if (rateLimited) {
    const at = job.updated_at ? new Date(job.updated_at).getTime() : NaN;
    const waited = Number.isFinite(at) ? (nowMs - at) / 1000 : 0;
    if (waited < RATE_LIMITED_COOLDOWN_S) {
      return { kind: 'cooldown', retry_after_s: Math.max(1, Math.ceil(RATE_LIMITED_COOLDOWN_S - waited)) };
    }
  }
  return { kind: 'eligible', retries_left: RETRY_CAP - depth };
}
