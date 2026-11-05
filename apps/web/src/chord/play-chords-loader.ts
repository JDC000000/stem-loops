// Completed-job chord loader (Y1 QA-T4).
//
// Fetch flow:
//   1. GET /api/jobs/<jobId>/play-chords  → { signed_url, expires_in_sec }
//        - 404 → unavailable (no chord artifact for this job: not done, the
//          provider rejected/failed, or chords were never attempted).
//   2. GET <signed_url>  → the JSON written by the worker (shape = asdict of
//      the ChordResult Pydantic model in apps/worker/src/worker/chord_source.py).
//      404 here also → unavailable (R2 miss / expired signed URL).
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
  /** Optional tombstone fields. The worker does not write these today (a failed
   *  or over-length chord pass writes NO object), but the loader honours them
   *  so a future tombstone gives users a specific reason with no web change. */
  status?: string;
  reason?: string;
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
 * Why a job has no chords. `unknown` is the honest default: today the worker
 * writes nothing when the pass is skipped or fails, so the web cannot tell
 * "too long" from "provider failed" from "never attempted" without a tombstone.
 */
export type ChordUnavailableReason =
  | 'too_long' // over the provider's 300s limit
  | 'too_short'
  | 'provider_failed' // provider/quota/upload error after we tried
  | 'not_attempted' // chords disabled or no harmonic input
  | 'load_failed' // the artifact may exist but we could not fetch it (network / 5xx)
  | 'unknown'; // no artifact and no reason recorded

/** Tri-state result: `loading` is "not yet", `unavailable` is "never". */
export type PlayChordsResult =
  | { status: 'loading' }
  | { status: 'ready'; observations: ChordObservation[] }
  | { status: 'unavailable'; reason: ChordUnavailableReason };

const LOADING: PlayChordsResult = { status: 'loading' };

/** Normalise a reason string from the API/worker onto the known set. */
export function parseUnavailableReason(raw: unknown): ChordUnavailableReason {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.toLowerCase();
  if (v === 'too_long' || v === 'chords_too_long' || v === 'duration_too_long') return 'too_long';
  if (v === 'too_short' || v === 'duration_too_short') return 'too_short';
  if (v === 'provider_failed' || v === 'chords_failed' || v === 'provider_error') return 'provider_failed';
  if (v === 'not_attempted' || v === 'disabled' || v === 'skipped') return 'not_attempted';
  return 'unknown';
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function reasonFrom(body: unknown): ChordUnavailableReason {
  if (!body || typeof body !== 'object') return 'unknown';
  const b = body as { reason?: unknown; unavailable_reason?: unknown };
  return parseUnavailableReason(b.unavailable_reason ?? b.reason);
}

/**
 * Non-React fetch primitive. Resolves to `ready` or `unavailable` (never
 * `loading`). A 404 at either tier is "no chords exist" (`unavailable`, with a
 * reason if the body or payload carries one). Other HTTP errors throw so the
 * hook can map them to `load_failed` and Sentry can see them.
 */
export async function fetchPlayChords(
  jobId: string,
  signal?: AbortSignal,
): Promise<PlayChordsResult> {
  // Tier 1: API-route envelope with the signed URL.
  const envRes = await fetch(`/api/jobs/${jobId}/play-chords`, {
    cache: 'no-store',
    signal,
  });
  if (envRes.status === 404) {
    return { status: 'unavailable', reason: reasonFrom(await readJsonSafe(envRes)) };
  }
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
  if (r2Res.status === 404) return { status: 'unavailable', reason: 'unknown' };
  if (!r2Res.ok) {
    throw new Error(`play-chords R2 ${r2Res.status}`);
  }
  const payload = (await r2Res.json()) as unknown;
  if (payload && typeof payload === 'object') {
    const p = payload as PlayChordsPayload;
    if (p.status === 'unavailable') {
      return { status: 'unavailable', reason: parseUnavailableReason(p.reason) };
    }
  }
  return { status: 'ready', observations: toObservations(payload) };
}

/**
 * React hook. Starts `loading`; resolves to `ready` (possibly zero chords) or
 * `unavailable` with a reason. A thrown fetch (network / 5xx) becomes
 * `unavailable: load_failed` so the UI never spins forever.
 *
 * A missing `jobId` returns `loading` without a fetch (the ChordOverlay's
 * live-capture mode ignores the value).
 */
export function usePlayChords(jobId: string | null | undefined): PlayChordsResult {
  const [result, setResult] = useState<PlayChordsResult>(LOADING);

  useEffect(() => {
    setResult(LOADING);
    if (!jobId) return;
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const data = await fetchPlayChords(jobId, controller.signal);
        if (!stopped) setResult(data);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.error('play-chords: fetch failed', err);
        if (!stopped) setResult({ status: 'unavailable', reason: 'load_failed' });
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [jobId]);

  return result;
}
