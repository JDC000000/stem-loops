// Completed-job chord loader (Y1 QA-T4).
//
// Fetch flow:
//   1. GET /api/jobs/<jobId>/play-chords  → { signed_url, expires_in_sec }
//        - 404 → null (no chord artifact for this job: either not done, no
//          Klangio pass, or the object wasn't written). The overlay falls
//          back to its idle/live-capture state.
//   2. GET <signed_url>  → the JSON written by the worker (shape = asdict of
//      the ChordResult Pydantic model in apps/worker/src/worker/chord_source.py).
//      404 here also → null (R2 miss / expired signed URL).
//
// Audio never leaves R2 → the browser via this path — only the JSON summary of
// the Klangio recognition pass does.

'use client';

import { useEffect, useState } from 'react';

/** One chord region. Matches ChordSegment in apps/worker/src/worker/chord_source.py
 *  one-for-one (snake_case → camelCase), so the on-wire contract is stable even
 *  if downstream smoothers reuse the segments for Viterbi input. */
export interface ChordObservation {
  /** Inclusive region start (seconds, aligned to the uploaded audio). */
  startSec: number;
  /** Exclusive region end (seconds). `endSec >= startSec`. */
  endSec: number;
  /** Harte-syntax label (e.g. "C:maj", "F#:7"); "N" = no chord, "X" = unknown. */
  label: string;
  /** Provider confidence in [0, 1]. Klangio ships 1.0 flat in Y1. */
  confidence: number;
}

/** Shape of the worker-written play.chords.json (ChordResult dataclass asdict). */
interface PlayChordsPayload {
  segments?: Array<{
    start_sec?: number;
    end_sec?: number;
    label?: string;
    confidence?: number;
  }>;
  // Fields below exist in the payload but are not consumed by the overlay
  // today; the loader ignores them rather than failing the fetch.
  key?: string | null;
  provider?: string;
  provider_version?: string;
  duration_sec?: number;
  model_ms?: number;
}

/** Shape of the API-route envelope. */
interface SignedUrlEnvelope {
  signed_url?: string;
  expires_in_sec?: number;
}

/**
 * Map the worker's snake_case segments onto the camelCase observation type.
 * Returns an empty array if `segments` is missing / not an array — a valid JSON
 * doc with zero segments is a legal "no chords recognised" response.
 */
function toObservations(payload: unknown): ChordObservation[] {
  if (!payload || typeof payload !== 'object') return [];
  const segs = (payload as PlayChordsPayload).segments;
  if (!Array.isArray(segs)) return [];
  const out: ChordObservation[] = [];
  for (const row of segs) {
    if (!row || typeof row !== 'object') continue;
    const startSec = Number(row.start_sec);
    const endSec = Number(row.end_sec);
    const label = typeof row.label === 'string' ? row.label : '';
    const confidence = Number(row.confidence);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !label) continue;
    out.push({
      startSec,
      endSec,
      label,
      confidence: Number.isFinite(confidence) ? confidence : 1,
    });
  }
  return out;
}

/**
 * Non-React fetch primitive. Exposed so server-side code (or tests) can call it
 * without pulling in React. `signal` lets a React caller abort when the effect
 * unmounts mid-flight.
 *
 * Returns `null` for any 404 (either tier) — the overlay treats "no data" and
 * "data gone / expired" the same. Other errors throw so Sentry can see them
 * via the hook's effect-level catch.
 */
export async function fetchPlayChords(
  jobId: string,
  signal?: AbortSignal,
): Promise<ChordObservation[] | null> {
  // Tier 1: API-route envelope with the signed URL.
  const envRes = await fetch(`/api/jobs/${jobId}/play-chords`, {
    cache: 'no-store',
    signal,
  });
  if (envRes.status === 404) return null;
  if (!envRes.ok) {
    throw new Error(`play-chords API ${envRes.status}`);
  }
  const envelope = (await envRes.json()) as SignedUrlEnvelope;
  if (!envelope.signed_url) {
    throw new Error('play-chords API envelope missing signed_url');
  }

  // Tier 2: signed R2 GET. The URL is minted with a 5-minute TTL — anything
  // longer than that between the two fetches is a pathological client state
  // we treat as "no data" rather than a hard error.
  const r2Res = await fetch(envelope.signed_url, { signal });
  if (r2Res.status === 404) return null;
  if (!r2Res.ok) {
    throw new Error(`play-chords R2 ${r2Res.status}`);
  }
  const payload = (await r2Res.json()) as unknown;
  return toObservations(payload);
}

/**
 * React hook. Returns `null` until the fetch resolves. On resolve:
 *   - `ChordObservation[]` on success (possibly empty).
 *   - `null` if the artifact doesn't exist (404 at either tier).
 *
 * A missing `jobId` short-circuits (null without a fetch) so the ChordOverlay
 * can toggle between its live-capture and completed-job modes with one hook.
 */
export function usePlayChords(jobId: string | null | undefined): ChordObservation[] | null {
  const [observations, setObservations] = useState<ChordObservation[] | null>(null);

  useEffect(() => {
    if (!jobId) {
      setObservations(null);
      return;
    }
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const data = await fetchPlayChords(jobId, controller.signal);
        if (!stopped) setObservations(data);
      } catch (err) {
        // AbortError on unmount is expected; everything else surfaces so the
        // overlay can degrade without masking real bugs.
        if ((err as Error)?.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.error('play-chords: fetch failed', err);
        if (!stopped) setObservations(null);
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [jobId]);

  return observations;
}
