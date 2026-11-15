// When a song's loops can still be asked for, and what to say when they cannot.
//
// JON, 2026-11-14: loops can be requested only within 24 hours of the job. After
// that the control is DISABLED with a plain explanation. No retention change.
//
// Why 24 hours and not some other number: the on-demand cut (migration 033,
// worker/loop_cutter.py) slices the retained stem WAVs, and those are deleted
// with everything else when the job expires (jobs.expires_at = created_at + 24h,
// migration 007; lib/retention.ts). There is nothing to cut from after that, so
// the window IS the retention window. It is read from RETENTION_MS rather than
// restated, so a retention change moves this with it.
//
// The SERVER already refuses: POST /api/jobs/:id/loops selects with
// `expires_at > now()` and answers 404 past it. This module is the UI half — it
// decides when to show the button disabled instead of letting a press fail.
//
// Erasable-syntax only, and no `@/` imports, so node's type stripping can run
// its tests directly (test/loops-page.test.mjs).
import { RETENTION_MS } from '../retention.ts';

/** How long after a song is split its loops can be cut. Same as retention, by design. */
export const LOOPS_WINDOW_MS = RETENTION_MS;

/** Why the Cut control is off. `null` means it is on. */
export type LoopsClosedReason = 'expired' | 'not_found' | 'no_stems';

/**
 * The plain explanations shown beside a disabled Cut control. One sentence of
 * what happened, one of what to do. Brand tone: "on our end".
 */
export const LOOPS_CLOSED_COPY: Readonly<Record<LoopsClosedReason, string>> = {
  expired:
    'Loops can only be cut within 24 hours of splitting a song. This song is older than that, so its audio has been deleted on our end. ' +
    'To get its loops, start the song again. It counts as a new track.',
  not_found:
    'We could not find that song. Songs are deleted 24 hours after they are split, so it may be older than that, or the link may be wrong. ' +
    'To get its loops, start the song again. It counts as a new track.',
  no_stems:
    'This song’s stems were not kept, so its loops cannot be cut. To get its loops, start the song again. It counts as a new track.',
};

/**
 * Is the loops window still open for a job?
 *
 * Prefers the job's own `expires_at` (the server's clock decided it) and falls
 * back to `createdAtMs + LOOPS_WINDOW_MS` (this browser's history entry, which
 * is all the picker has before the job is fetched). With neither, it is open:
 * the server is the authority and will say 404 if it is not.
 */
export function loopsWindowOpen(
  job: { readonly expiresAtMs?: number | null; readonly createdAtMs?: number | null },
  nowMs: number = Date.now(),
): boolean {
  const end =
    typeof job.expiresAtMs === 'number' && Number.isFinite(job.expiresAtMs)
      ? job.expiresAtMs
      : typeof job.createdAtMs === 'number' && Number.isFinite(job.createdAtMs)
        ? job.createdAtMs + LOOPS_WINDOW_MS
        : null;
  return end === null || nowMs < end;
}

/** `expires_at` as ms, or null when absent or unparseable. */
export function expiresAtMsOf(expiresAt: string | null | undefined): number | null {
  if (expiresAt == null) return null;
  const t = new Date(expiresAt).getTime();
  return Number.isNaN(t) ? null : t;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A job id out of whatever was pasted: a bare id, a /jobs/<id> link, or a
 * /loops?job=<id> link. Lowercased, because Postgres renders uuids lowercase
 * and the stems route builds an R2 prefix from the id (see its comment).
 */
export function jobIdFrom(input: string | null | undefined): string | null {
  const m = (input ?? '').trim().match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}
