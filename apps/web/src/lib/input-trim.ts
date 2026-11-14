/**
 * Input trim — "we used the first 5 minutes of your song".
 *
 * Since 2026-11-14 a track longer than the worker's MAX_UPLOAD_DURATION_SEC (300 s, the same
 * number as MAX_TRACK_SEC) is TRIMMED to its first 300 s instead of refused (Jon: "If a song
 * is more than 5 minutes, it should still be converted to a play along"). The worker records
 * the trim on the `downloading` / `completed` job event:
 *
 *     job_events.detail = {"trimmed": true, "source_sec": 372.4, "used_sec": 300.0}
 *
 * `source_sec` is null when the original length could not be read. GET /api/jobs/:id reads
 * that detail (and ONLY that: `detail` also carries `cost_usd` on other events, which is
 * never sent to the browser) and exposes it as `input_trim_used_sec` / `input_trim_source_sec`.
 *
 * Relative imports WITH the .ts extension: node:test loads this file directly.
 */

export interface InputTrim {
  /** Seconds of the track that were processed (the cap). */
  usedSec: number;
  /** The original length, or null when it could not be read. */
  sourceSec: number | null;
}

interface EventLike {
  stage?: unknown;
  phase?: unknown;
  detail?: unknown;
}

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * The trim recorded on a job's events, or null if the input was not trimmed. Reads the LAST
 * `downloading`/`completed` event (a reaper rerun emits a fresh one) and accepts only the
 * exact shape the worker writes — anything else is "not trimmed", never a guess.
 */
export function inputTrimFromEvents(events: readonly EventLike[]): InputTrim | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.stage !== 'downloading' || e.phase !== 'completed') continue;
    const d = e.detail;
    if (!d || typeof d !== 'object') return null;
    const rec = d as Record<string, unknown>;
    if (rec.trimmed !== true) return null;
    const usedSec = positive(rec.used_sec);
    if (usedSec === null) return null;
    return { usedSec, sourceSec: positive(rec.source_sec) };
  }
  return null;
}

/** m:ss. Tracks shown here are minutes long; hours are rendered as large minutes. */
function clock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The one-line note for the job page, e.g. "Using the first 5:00 of a 6:12 track."
 *
 * The used length is ROUNDED (a cut can read 299.98 s), the source length is rounded UP so
 * a 300.4 s original never reads as "the first 5:00 of a 5:00 track".
 */
export function trimNote(usedSec: number, sourceSec: number | null): string {
  const used = clock(Math.round(usedSec));
  if (sourceSec === null || !(sourceSec > usedSec)) return `Using the first ${used} of this track.`;
  return `Using the first ${used} of a ${clock(Math.ceil(sourceSec))} track.`;
}

/** The note for a job JSON as served by GET /api/jobs/:id, or null if it was not trimmed. */
export function jobTrimNote(job: {
  input_trim_used_sec?: number | null;
  input_trim_source_sec?: number | null;
}): string | null {
  const used = positive(job.input_trim_used_sec);
  if (used === null) return null;
  return trimNote(used, positive(job.input_trim_source_sec));
}
