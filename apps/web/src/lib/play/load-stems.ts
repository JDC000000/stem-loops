/**
 * Stem loader: fetch a job's playback stems and return `LoadedStems`.
 *
 * Contract: `./types.ts` (`LoadedStems`, `StemSource`, `PLAYABLE_STEMS`).
 * Server shape: `GET /api/jobs/:id/stems` (PR #176) ->
 *   { stems: [{ stem, signed_url }], expected, complete, state, expires_in_sec }
 *
 * URL-EXPIRY STRATEGY (the decision, and why)
 * -------------------------------------------
 * Signed URLs live min(900 s, time-to-job-expiry). A play-along session can
 * outlive that, but bytes are only fetched ONCE, at load time, so expiry bites
 * in exactly two places: a slow/retried download, and a re-load of the same
 * page later. Strategy:
 *
 *  1. REACTIVE, not timer-driven. We do not schedule refreshes off
 *     `expires_in_sec` (it is advisory, and a client timer cannot know the
 *     server clock). A download answering 403 (what R2 returns for an expired
 *     signature) is the trigger.
 *  2. On 403, re-fetch the MANIFEST (never reuse a dead URL) and retry that stem
 *     with its fresh URL. Single-flight: if all six stems 403 together, ONE
 *     manifest request serves them all (generation counter).
 *  3. BOUNDED. At most MAX_MANIFEST_REFRESHES (2) refreshes per `loadStems` call.
 *     Worst case is 1 + 2 = 3 manifest requests per call, against a 60/min/IP
 *     limit. A stem still 403 after the budget goes to `missing`; we never loop.
 *     A caller wanting to try again later calls `loadStems` anew.
 *  4. `expires_in_sec` <= 0 / non-finite is NOT trusted or acted on up front: we
 *     still try the URLs, and the bounded 403 path handles reality. A hostile or
 *     buggy value therefore cannot cause a refresh loop.
 *  5. A refresh that returns 429 or 404 is fatal for the whole load (thrown): a
 *     rate-limited user must be told that, not "drums are missing".
 *
 * Failure model: a stem that is absent, 404s, errors, or returns an empty body
 * is `missing`, never an exception. Only manifest-level problems and abort throw.
 */
import { PLAYABLE_STEMS } from './types.ts';
import type { LoadedStems, StemName, StemSource } from './types.ts';

export const MAX_MANIFEST_REFRESHES = 2;

export type StemLoadErrorCode =
  | 'RATE_LIMITED' // manifest 429: "too many requests, try again shortly"
  | 'NOT_FOUND' // manifest 404: job missing, expired or not done
  | 'MANIFEST_FAILED' // manifest other non-2xx or network failure
  | 'MANIFEST_INVALID' // 2xx but not the documented shape
  | 'ABORTED'; // caller's AbortSignal fired

export class StemLoadError extends Error {
  readonly code: StemLoadErrorCode;
  readonly status?: number;
  /** Seconds, from a parseable Retry-After header on a 429. */
  readonly retryAfterSec?: number;
  constructor(code: StemLoadErrorCode, message: string, extra: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = 'StemLoadError';
    this.code = code;
    this.status = extra.status;
    this.retryAfterSec = extra.retryAfterSec;
  }
}

export interface LoadStemsOptions {
  readonly signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** Prefix for the manifest route, e.g. an origin. Default: same-origin. */
  readonly baseUrl?: string;
}

const STEM_SET: ReadonlySet<string> = new Set(PLAYABLE_STEMS);

/** Manifest -> stem/url map. Unknown names, duplicates (first wins) and bad URLs are dropped. */
function parseManifest(body: unknown): Map<StemName, string> {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { stems?: unknown }).stems)) {
    throw new StemLoadError('MANIFEST_INVALID', 'Stems manifest has an unexpected shape');
  }
  const urls = new Map<StemName, string>();
  for (const e of (body as { stems: unknown[] }).stems) {
    if (typeof e !== 'object' || e === null) continue;
    const { stem, signed_url } = e as { stem?: unknown; signed_url?: unknown };
    if (typeof stem !== 'string' || !STEM_SET.has(stem)) continue;
    if (typeof signed_url !== 'string' || !/^https?:\/\/\S+$/i.test(signed_url)) continue;
    if (!urls.has(stem as StemName)) urls.set(stem as StemName, signed_url);
  }
  return urls;
}

export async function loadStems(jobId: string, opts: LoadStemsOptions = {}): Promise<LoadedStems> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const outer = opts.signal;
  const throwIfAborted = () => {
    if (outer?.aborted) throw new StemLoadError('ABORTED', 'Stem loading was cancelled');
  };
  throwIfAborted();

  // Internal controller: cancels sibling downloads when one failure is fatal.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });

  let fatal: StemLoadError | null = null;
  const fail = (e: StemLoadError) => {
    fatal ??= e;
    ctl.abort();
  };

  const manifestUrl = `${opts.baseUrl ?? ''}/api/jobs/${encodeURIComponent(jobId)}/stems`;

  async function fetchManifest(): Promise<Map<StemName, string>> {
    let res: Response;
    try {
      res = await doFetch(manifestUrl, { signal: ctl.signal, cache: 'no-store' });
    } catch {
      throwIfAborted();
      throw new StemLoadError('MANIFEST_FAILED', 'Could not reach the stems service');
    }
    if (res.status === 429) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new StemLoadError('RATE_LIMITED', 'Too many requests, try again shortly', {
        status: 429,
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
      });
    }
    if (res.status === 404) throw new StemLoadError('NOT_FOUND', 'Job not found or not ready', { status: 404 });
    if (!res.ok) throw new StemLoadError('MANIFEST_FAILED', `Stems service returned ${res.status}`, { status: res.status });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throwIfAborted();
      throw new StemLoadError('MANIFEST_INVALID', 'Stems manifest was not valid JSON');
    }
    return parseManifest(json);
  }

  try {
    let current = await fetchManifest();
    let generation = 0;
    let refreshes = 0;
    let inflight: Promise<void> | null = null;

    // Single-flight refresh. Returns once `generation` has advanced past `seen`
    // or the budget is spent (the caller's stem then becomes missing).
    const refresh = async (seen: number): Promise<void> => {
      if (generation > seen) return;
      if (inflight) return inflight;
      if (refreshes >= MAX_MANIFEST_REFRESHES) return;
      refreshes += 1;
      inflight = (async () => {
        try {
          current = await fetchManifest();
        } catch (e) {
          // 429/404/abort are fatal for the whole load; other failures leave the
          // old (dead) URLs, so the affected stems end up missing.
          if (e instanceof StemLoadError && (e.code === 'RATE_LIMITED' || e.code === 'NOT_FOUND' || e.code === 'ABORTED')) {
            fail(e);
          }
        } finally {
          generation += 1;
          inflight = null;
        }
      })();
      return inflight;
    }

    const download = async (stem: StemName): Promise<ArrayBuffer | null> => {
      let seen = generation;
      for (let attempt = 0; attempt <= MAX_MANIFEST_REFRESHES; attempt++) {
        const url = current.get(stem);
        if (!url) return null; // absent from the (refreshed) manifest
        let res: Response;
        try {
          res = await doFetch(url, { signal: ctl.signal });
        } catch {
          return null; // network error; aborts are re-checked by the caller
        }
        if (res.status === 403) {
          await refresh(seen);
          if (fatal || ctl.signal.aborted) return null;
          seen = generation;
          continue;
        }
        if (!res.ok) return null; // 404 etc: same as a missing stem
        try {
          const buf = await res.arrayBuffer();
          return buf.byteLength > 0 ? buf : null; // an empty 200 is not a stem
        } catch {
          return null;
        }
      }
      return null; // refresh budget spent while still 403
    }

    // Parallel, and emitted in PLAYABLE_STEMS order.
    const results = await Promise.all(
      PLAYABLE_STEMS.map(async (name) => ({ name, bytes: current.has(name) ? await download(name) : null })),
    );

    throwIfAborted();
    if (fatal) throw fatal;

    const sources: StemSource[] = [];
    const missing: StemName[] = [];
    for (const r of results) {
      if (r.bytes) sources.push({ name: r.name, bytes: r.bytes });
      else missing.push(r.name);
    }
    return { sources, missing };
  } catch (e) {
    if (fatal) throw fatal;
    throwIfAborted();
    throw e;
  } finally {
    outer?.removeEventListener('abort', onAbort);
  }
}
