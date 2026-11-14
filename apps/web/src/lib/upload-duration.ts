/**
 * Duration probe at admission — a HEADS-UP, NOT A LIMIT AND NOT A REFUSAL.
 *
 * WHAT THIS IS
 * ------------
 * Since 2026-11-14 any song is accepted, and a track longer than the cap is TRIMMED by the
 * worker to its first `MAX_UPLOAD_DURATION_SEC` seconds (Jon: "If a song is more than 5
 * minutes, it should still be converted to a play along, but it just [processes the first]
 * 5 minutes of the song"). Before that, this probe declined a >5 min file in the browser.
 *
 * Now it only lets the form TELL the visitor, before they submit, that a long track will be
 * trimmed: "This track is longer than 5 minutes — we'll use the first 5 minutes." The file
 * is never removed and submit is never blocked by the result.
 *
 * `validateUpload` (upload.ts) is given a filename and a byte count, because that is all
 * POST /api/uploads ever receives: the browser PUTs the bytes straight to R2 on a
 * presigned URL. So the browser measures the one thing only it can measure for free — the
 * duration in the file it already has in memory.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This runs in the visitor's browser and can be made to lie. THE TRIM IS
 * `MAX_UPLOAD_DURATION_SEC` IN THE WORKER (apps/worker/src/worker/pipeline.py), which decodes
 * with `ffmpeg -t cap` server-side before anything is handed to Replicate. Nothing here
 * changes what the worker does.
 *
 * WHICH IS WHY IT FAILS QUIET
 * ---------------------------
 * A browser that cannot measure a container (flac and aiff are patchy), a header reporting
 * `Infinity` or `NaN`, a slow decode, a blocked object URL — every one of those resolves
 * `null`, and the form simply shows no note. The worker trims either way.
 */
import { MAX_UPLOAD_DURATION_SEC } from './upload.ts';

/** How long to wait for the browser to report metadata before giving up and passing. */
export const PROBE_TIMEOUT_MS = 10_000;

export type DurationVerdict =
  /** Measured and within the cap, or not measurable at all: nothing to say. */
  | { trim: false; reason: 'within_cap' | 'unmeasured' }
  /** Measured, and longer than the cap: the worker will use only the first part. */
  | { trim: true; reason: 'over_cap'; seconds: number };

/**
 * The verdict, as a pure function of the probed duration. Separated from the probe itself so
 * it is testable without a DOM — node:test has no browser media stack.
 *
 * It never refuses: there is no `ok: false`. `null` means "the probe could not measure this".
 */
export function durationVerdict(seconds: number | null): DurationVerdict {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return { trim: false, reason: 'unmeasured' };
  }
  // Strict `>`, the same comparison the worker and the player make: exactly 5:00 is not trimmed.
  if (seconds > MAX_UPLOAD_DURATION_SEC) return { trim: true, reason: 'over_cap', seconds };
  return { trim: false, reason: 'within_cap' };
}

/** Whole minutes in the cap, fed from the one ceiling rather than typed as a figure. */
export const MAX_UPLOAD_MIN = Math.round(MAX_UPLOAD_DURATION_SEC / 60);

/**
 * The pre-submit note for a verdict, or null when there is nothing to say.
 * "This track is longer than 5 minutes — we'll use the first 5 minutes."
 */
export function trimNotice(verdict: DurationVerdict): string | null {
  if (!verdict.trim) return null;
  return `This track is longer than ${MAX_UPLOAD_MIN} minutes \u2014 we\u2019ll use the first ${MAX_UPLOAD_MIN} minutes.`;
}

/** Browser bits the probe needs, injectable so the fail-open paths are testable. */
export interface ProbeDeps {
  createElement: (tag: 'audio') => HTMLAudioElement;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  timeoutMs: number;
}

function defaultDeps(): ProbeDeps | null {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return null;
  }
  return {
    createElement: (tag) => document.createElement(tag),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    timeoutMs: PROBE_TIMEOUT_MS,
  };
}

/**
 * Duration of `file` in seconds, or `null` if it cannot be measured.
 *
 * NEVER REJECTS AND NEVER THROWS. Every failure — unsupported container, decode error,
 * timeout, no DOM (SSR), a thrown `createObjectURL` — resolves `null`, which
 * `durationVerdict` reads as "nothing to say".
 *
 * Uses an <audio> element with `preload='metadata'`, which reads the container header
 * only; it does not decode the audio and does not need Web Audio. An ffprobe-style
 * subprocess is not an option here and would not be in CI either, which has ffmpeg but
 * no ffprobe.
 */
export function probeDurationSec(file: Blob, deps?: Partial<ProbeDeps>): Promise<number | null> {
  const base = defaultDeps();
  if (!base && !(deps?.createElement && deps?.createObjectURL)) return Promise.resolve(null);
  const d: ProbeDeps = { ...(base as ProbeDeps), ...deps };

  return new Promise<number | null>((resolve) => {
    let url: string | null = null;
    let el: HTMLAudioElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        if (el) {
          el.onloadedmetadata = null;
          el.onerror = null;
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        /* teardown is best effort — never let it change the verdict */
      }
      try {
        if (url) d.revokeObjectURL(url);
      } catch {
        /* same */
      }
      resolve(value);
    };

    try {
      el = d.createElement('audio');
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish(el && Number.isFinite(el.duration) ? el.duration : null);
      el.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), d.timeoutMs);
      url = d.createObjectURL(file);
      el.src = url;
    } catch {
      finish(null);
    }
  });
}
