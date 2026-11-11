/**
 * Duration probe at admission — a SPEND-AND-UX GUARD, NOT A SECURITY BOUNDARY.
 *
 * WHAT THIS IS
 * ------------
 * `validateUpload` (upload.ts) is given a filename and a byte count, because that is all
 * POST /api/uploads ever receives: the browser PUTs the bytes straight to R2 on a
 * presigned URL, so no server of ours holds them at admission time. 200 MB of bytes is
 * ~3.5 h of 128 kbps mp3, which is no bound at all on how long a track is.
 *
 * So the browser measures the one thing only the browser can measure for free — the
 * duration in the file it already has in memory — and declines the obvious case BEFORE
 * the bytes are uploaded to R2 and before a paid Replicate separation is started.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This runs in the visitor's browser. Anything a browser measures, a browser can be made
 * to lie about, and POST /api/uploads can be called directly with no browser at all. This
 * check is therefore WORTH NOTHING as a limit, and nothing downstream may assume it ran.
 *
 * THE LIMIT IS `MAX_UPLOAD_DURATION_SEC` IN THE WORKER
 * (apps/worker/src/worker/pipeline.py), which probes the raw header and re-probes the
 * decoded WAV, server-side, before the URL is handed to Replicate. That is the enforcement
 * and it is unchanged by anything in this file.
 *
 * WHICH IS WHY IT FAILS OPEN
 * --------------------------
 * A browser that cannot measure a container it still accepts for upload (flac and aiff in
 * particular are patchy), a file whose header reports `Infinity` or `NaN`, a slow decode,
 * a blocked object URL — every one of those resolves `null` and the upload PROCEEDS. A
 * guard that is not the limit must never be the thing that turns away a legitimate track;
 * the worker will catch a real over-length file either way, and the cost of a false
 * refusal here is a user who cannot use the product at all.
 */
import { MAX_UPLOAD_DURATION_SEC } from './upload.ts';

/** How long to wait for the browser to report metadata before giving up and passing. */
export const PROBE_TIMEOUT_MS = 10_000;

export type DurationVerdict =
  /** Measured and within the cap, or not measurable at all (see FAIL OPEN above). */
  | { ok: true; reason: 'within_cap' | 'unmeasured' }
  /** Measured, and longer than the cap. */
  | { ok: false; reason: 'too_long'; seconds: number };

/**
 * The gate, as a pure function of the probed duration. Separated from the probe itself so
 * it is testable without a DOM — node:test has no browser media stack — and so the rule
 * is one expression rather than something spread through a React callback.
 *
 * `null` means "the probe could not measure this", and is a PASS.
 */
export function durationVerdict(seconds: number | null): DurationVerdict {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: true, reason: 'unmeasured' };
  }
  if (seconds > MAX_UPLOAD_DURATION_SEC) return { ok: false, reason: 'too_long', seconds };
  return { ok: true, reason: 'within_cap' };
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
 * `durationVerdict` reads as a pass.
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
