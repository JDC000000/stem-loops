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
 *     signature) is the trigger. A pre-emptive timer would save nothing anyway:
 *     all six downloads start in the same tick, and R2 checks the signature at
 *     request start, so either they are all still valid or they all 403.
 *  2. On 403, re-fetch the MANIFEST (never reuse a dead URL) and retry that stem
 *     with its fresh URL. Single-flight: if all six stems 403 together, ONE
 *     manifest request serves them all. TWO guards do that and both are
 *     load-bearing: `inflight` joins the stems that 403 *during* a refresh, and
 *     the `generation` counter stops a stem that 403s *after* a refresh has
 *     already completed from kicking off a redundant second one.
 *  3. BOUNDED PER CALL. At most MAX_MANIFEST_REFRESHES (2) refreshes per
 *     `loadStems` call, so the worst case is 1 + 2 = 3 manifest requests per
 *     call. A stem still 403 after the budget goes to `missing`; we never loop.
 *
 *     That bound is PER CALL and nothing more — there is deliberately no
 *     cross-call memory, so it is NOT a storm bound. 30 sequential all-403 loads
 *     make 90 manifest requests and would blow the route's 60/min/IP limit.
 *     Back-off is therefore a CALLER OBLIGATION: on a thrown `RATE_LIMITED`
 *     honour `retryAfterSec`, and on a partial result honour
 *     `refreshFailure.retryAfterSec`, before calling `loadStems` again.
 *  4. `expires_in_sec` <= 0 / non-finite is NOT trusted or acted on up front: we
 *     still try the URLs, and the bounded 403 path handles reality. A hostile or
 *     buggy value therefore cannot cause a refresh loop.
 *  5. A refresh that returns 429 or 404 does NOT throw away stems that already
 *     downloaded. The job expiring mid-load is exactly when a partial result is
 *     most valuable. So: record the failure, leave siblings holding valid URLs
 *     alone, send the stems that needed the refresh to `missing`, and return the
 *     partial result with `refreshFailure` set so the UI can say "too many
 *     requests" instead of silently degrading. Story 5 — the player works with a
 *     stem missing and SAYS which, rather than failing whole.
 *
 *     It is thrown only when NOTHING loaded: a result with zero sources is not a
 *     degraded player, it is a failed load, and there the caller needs the code
 *     and `retryAfterSec` to decide when to come back.
 *
 * Failure model: a stem that is absent, 404s, errors, exceeds MAX_STEM_BYTES or
 * returns an empty body is `missing`, never an exception. Only manifest-level
 * problems, abort, and a refresh failure with zero stems loaded throw.
 *
 * KNOWN RESIDUES (accepted, not oversights)
 * -----------------------------------------
 *  - No retry on a stem 5xx or network error — straight to `missing`. Only 403
 *    is retried, because only 403 has a known and bounded cure.
 *  - No per-request timeout. A stem download that hangs forever hangs the load.
 *    `AbortSignal` is the lever and composing a deadline into it is a caller
 *    obligation (`AbortSignal.any([signal, AbortSignal.timeout(ms)])`).
 *  - The unknown-stem guard in `parseManifest` is defence in depth: because
 *    `PLAYABLE_STEMS` drives the download loop, deleting it is an equivalent
 *    mutant. It stays so that a future caller iterating the manifest itself
 *    cannot be handed `kazoo` or `__proto__`.
 *  - Three more equivalent mutants, measured and kept on purpose rather than
 *    left unmentioned. Each is unobservable ALONE but not as a pair, and the
 *    suite kills the pair:
 *      * `if (refreshFail.current) return` inside `refresh` is masked by the
 *        same check in `download`'s 403 branch, and vice versa. Removing BOTH
 *        is caught. Two guards because either one moving later should not
 *        silently re-open re-fetching a URL the route has already refused.
 *      * `refreshFail.current ??= e` vs `=`: only one refresh failure can ever
 *        be recorded, since the next refresh short-circuits on it.
 *      * `fail(e)` on an ABORTED refresh: `ctl` is aborted only by the caller's
 *        signal, which `throwIfAborted()` already turns into ABORTED.
 */
import { PLAYABLE_STEMS } from './types.ts';
import type { LoadedStems, StemName, StemSource } from './types.ts';

export const MAX_MANIFEST_REFRESHES = 2;

/**
 * Hard per-stem byte cap, enforced on `Content-Length` AND on bytes actually
 * read.
 *
 * Why 16 MiB: a real stem is a 48 kHz mono Opus of a <=300 s track (types.ts
 * MAX_TRACK_SEC), which measures ~2-2.5 MB. 16 MiB is ~6x the largest real stem,
 * so nothing legitimate trips it, while six of them bound one load at 96 MiB of
 * compressed bytes against the ~576 MB RSS budget that types.ts records as
 * SHIPPING. Without a cap a single bad encode, a wrong object key, or a slow
 * body we keep accumulating hands us an unbounded ArrayBuffer and OOMs the tab
 * before `decodeAudioData` is even reached — a 64 MB body is accepted today.
 *
 * Content-Length alone is not enough: it is absent on a chunked response and a
 * server is free to lie about it, so the streaming read counts too and bails the
 * moment the running total crosses the cap, keeping nothing.
 */
export const MAX_STEM_BYTES = 16 * 1024 * 1024;

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

/**
 * A manifest refresh that failed while at least one stem had already
 * downloaded. Same fields as `StemLoadError`, as plain data: it is a reportable
 * condition, not a thrown one. Carries `retryAfterSec` because honouring it is
 * the caller's obligation (see strategy note 3).
 */
export interface StemRefreshFailure {
  readonly code: StemLoadErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterSec?: number;
}

/**
 * `LoadedStems` plus WHY the result is degraded, when we know.
 *
 * Extends the contract rather than editing `types.ts`: every existing consumer
 * keeps working because this is assignable to `LoadedStems`, and `missing`
 * still feeds `EngineSnapshot.degraded` untouched. A UI that wants to
 * distinguish "the encoder never made vocals" from "the signed-URL route
 * rate-limited us mid-load" reads `refreshFailure`; one that does not, ignores
 * it. `null` on every clean load, including a load degraded for ordinary
 * reasons (a stem absent from the manifest, a 404, an empty body).
 */
export interface LoadStemsResult extends LoadedStems {
  readonly refreshFailure: StemRefreshFailure | null;
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

/**
 * Read one stem body, refusing anything over MAX_STEM_BYTES.
 *
 * Returns `null` for "treat as missing": over the cap, or empty. Two gates,
 * because either one alone is bypassable — a declared Content-Length can be
 * absent or a lie, and a body read without a running total is unbounded.
 */
async function readBoundedBody(res: Response): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers?.get?.('content-length'));
  // Cheap gate: refuse before a single byte is read.
  if (Number.isFinite(declared) && declared > MAX_STEM_BYTES) return null;

  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== 'function') {
    // No readable stream (a shim or a test double). Nothing to count as we go,
    // so the after-the-fact check is the best available.
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0 && buf.byteLength <= MAX_STEM_BYTES ? buf : null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Truthful gate: stop the transfer and keep nothing.
      if (total > MAX_STEM_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total === 0) return null; // an empty 200 is not a stem
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export async function loadStems(jobId: string, opts: LoadStemsOptions = {}): Promise<LoadStemsResult> {
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
    /**
     * A 429/404 on a REFRESH. Recorded, never fatal: it must not cancel
     * siblings that are already downloading on URLs that still work. Boxed so
     * that the assignment, which happens inside the refresh closure, is visible
     * to narrowing out here.
     */
    const refreshFail: { current: StemLoadError | null } = { current: null };

    // Single-flight refresh. Returns once `generation` has advanced past `seen`
    // or the budget is spent (the caller's stem then becomes missing).
    const refresh = async (seen: number): Promise<void> => {
      if (generation > seen) return;
      if (inflight) return inflight;
      // The manifest route has already refused us; do not hammer it again.
      if (refreshFail.current) return;
      if (refreshes >= MAX_MANIFEST_REFRESHES) return;
      refreshes += 1;
      inflight = (async () => {
        try {
          current = await fetchManifest();
        } catch (e) {
          if (e instanceof StemLoadError && e.code === 'ABORTED') {
            // The caller cancelled: there is nothing to salvage.
            fail(e);
          } else if (e instanceof StemLoadError && (e.code === 'RATE_LIMITED' || e.code === 'NOT_FOUND')) {
            // Record and carry on. Stems already in flight keep their valid
            // URLs; the ones that needed this refresh become `missing`.
            refreshFail.current ??= e;
          }
          // Any other refresh failure leaves the old (dead) URLs in place, so
          // the affected stems end up missing without a special case.
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
          if (fatal || refreshFail.current || ctl.signal.aborted) return null;
          seen = generation;
          continue;
        }
        if (!res.ok) return null; // 404 etc: same as a missing stem
        try {
          return await readBoundedBody(res);
        } catch {
          return null; // truncated transfer, body already consumed, etc.
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
    // Zero sources is a failed load, not a degraded one: throw so the caller
    // gets the code and can honour retryAfterSec. With anything playable, the
    // partial result plus `refreshFailure` is strictly more useful.
    const failed = refreshFail.current;
    if (failed && sources.length === 0) throw failed;
    return {
      sources,
      missing,
      refreshFailure: failed
        ? { code: failed.code, message: failed.message, status: failed.status, retryAfterSec: failed.retryAfterSec }
        : null,
    };
  } catch (e) {
    if (fatal) throw fatal;
    throwIfAborted();
    throw e;
  } finally {
    outer?.removeEventListener('abort', onAbort);
  }
}
