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
 *     In practice the budget is only ever spent on refreshes that SUCCEED and
 *     still hand back a URL that 403s, because the first refresh failure stops
 *     the retrying outright (note 5).
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
 *  5. A FAILED REFRESH DOES NOT THROW AWAY STEMS THAT ALREADY DOWNLOADED, and
 *     is never swallowed. The job expiring mid-load is exactly when a partial
 *     result is most valuable. So, for ANY refresh failure — 429, 404, 5xx,
 *     network, invalid JSON alike: record it in `refreshFail`, leave siblings
 *     holding valid URLs alone, send the stems that needed the refresh to
 *     `missing`, and return the partial result with `refreshFailure` set so the
 *     UI can name the cause instead of silently degrading. Story 5 — the player
 *     works with a stem missing and SAYS which, rather than failing whole.
 *     (Story 5 in the contract: `types.ts:64` `StemAvailability`, `:121`
 *     `EngineSnapshot.degraded`, `:170-179` `LoadedStems`.)
 *
 *     Recording EVERY failure, not just 429/404, is what makes the field
 *     trustworthy: a swallowed refresh 5xx left `refreshFailure` null and the UI
 *     saying "the encoder never made vocals" when the truth was "the URL expired
 *     and the refresh route was down". It also ends the retry loop at the first
 *     failure, so a known-dead URL is not re-fetched for the rest of the budget.
 *
 *     The cost, accepted: a TRANSIENT refresh 5xx is no longer retried, even
 *     though the second refresh might have worked. Re-fetching a URL that is
 *     already known dead, twice, against a route that is already failing, is
 *     the worse trade.
 *
 * Failure model: a stem that is absent, 404s, 429s, errors, exceeds
 * MAX_STEM_BYTES or returns an empty body is `missing`, never an exception. Only
 * manifest-level problems, abort, and a nameable failure with zero stems loaded
 * throw. See THE ZERO-SOURCE RULE at the bottom of `loadStems` for exactly when
 * a zero-source load is a thrown error and when it is a returned result.
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
 *  - MAX_IDLE_READS and the two yields in the reader are DEFENSIVE. The
 *    empty-chunk stall they close reproduces against an in-process stream but
 *    NOT over real HTTP — undici coalesces, and HTTP/1.1 chunked encoding cannot
 *    express a zero-length chunk without ending the body. They are kept because
 *    the loader accepts an injected `fetch`, so an in-process source is a
 *    supported input, and because without the yields the documented
 *    `AbortSignal.timeout` mitigation provably could not fire (there is a test
 *    for exactly that).
 *  - Equivalent mutants, measured and listed so nobody re-derives them. Each is
 *    unobservable, and that is a property of the code, not a gap in the tests:
 *      * `if (refreshFail.current) return` inside `refresh`. Deleting it changes
 *        nothing because `if (generation > seen) return` on the line above
 *        catches the same callers first: all six downloads sample `seen` in the
 *        same tick, so once a refresh has completed — successfully or not —
 *        `generation` has already advanced past every stem's `seen`. (An earlier
 *        revision of this comment blamed the guard in `download`; that was the
 *        wrong mechanism.) Kept because a future change to how `seen` is sampled
 *        would otherwise silently re-open refreshing against a route that has
 *        already refused us.
 *      * `refreshFail.current ??= e` vs `=` inside `note`: unreachable, because
 *        the first recorded failure stops every later refresh and every later
 *        403 retry, so a second record cannot happen.
 *      * recording an ABORTED refresh into `refreshFail` instead of skipping
 *        it: the final `throwIfAborted()` runs before the zero-source rule, so
 *        the recorded value could never be read. Skipped anyway, because
 *        `refreshFailure` describes a DEGRADED load and an aborted one is not.
 *      * dropping the `current.has(name)` pre-check in the `Promise.all`:
 *        `download` re-reads `current.get(stem)` and returns null for a miss,
 *        so the pre-check only avoids entering the loop.
 *    Two more were removed rather than documented, because they were dead
 *    machinery rather than defence: the `fatal`/`fail()` pair and its
 *    `if (fatal) throw fatal` sites. With note 5 in place `fail()` was reachable
 *    only from the ABORTED refresh branch, which `throwIfAborted()` already
 *    covers, so the whole mechanism went. `ctl` itself stays — it is the shared
 *    signal that carries the caller's abort into every in-flight request.
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
 * so nothing legitimate trips it. Without a cap a single bad encode, a wrong
 * object key, or a slow body we keep accumulating hands us an unbounded
 * ArrayBuffer and OOMs the tab before `decodeAudioData` is even reached.
 *
 * What the cap bounds, stated precisely, because the loose version of this
 * sentence was wrong. Six stems at the cap RETAIN 96 MiB of compressed bytes.
 * The transient PEAK is higher, and the peak is what matters against the
 * ~576 MB RSS the types.ts note records as SHIPPING against a 600 MB bar — only
 * ~4% of headroom, with `decodeAudioData` PCM landing on top of it.
 *
 * MEASURED here, six stems at exactly the cap, 64 KiB chunks over loopback HTTP,
 * node 22.23.4, whole-process peak RSS sampled every 2 ms against a 35.8 MiB
 * empty-process baseline, 4 runs each:
 *   Content-Length present (pre-sized)   96.0 MiB retained / 229.6-230.2 MiB peak
 *   Content-Length absent (accumulate)   96.0 MiB retained / 269.6-289.9 MiB peak
 * The second is worse because the reader holds every chunk AND the assembled
 * copy at the same time. That is why the Content-Length path reads straight into
 * one pre-sized buffer — 40-60 MiB off the peak in the normal case, since R2
 * always sends Content-Length on a GET. Peak is ~2.4x retained either way, so
 * size the cap against the peak, not the 96 MiB.
 *
 * Content-Length alone is not enough to bound anything: it is absent on a
 * chunked response and a server is free to lie about it, so the streaming read
 * counts too and bails the moment the running total crosses the cap, keeping
 * nothing. The pre-sized buffer is an allocation hint, never the bound.
 */
export const MAX_STEM_BYTES = 16 * 1024 * 1024;

/**
 * Consecutive zero-length reads tolerated before a stem body is abandoned.
 * Guards the one shape the byte cap cannot see: an endless stream of empty
 * chunks, which never grows the running total. 1024 is far more than any real
 * transfer produces (a conformant sender emits none) and small enough to end
 * the spin promptly — the reader yields on each such read, so reaching the bound
 * costs on the order of a second of wall time, during which a caller's
 * AbortSignal can and does fire.
 */
export const MAX_IDLE_READS = 1024;

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
 * A nameable failure that degraded a load which still produced something: a
 * manifest refresh that failed for any reason, or a stem object that answered
 * 429. Same fields as `StemLoadError`, as plain data, because it is a reportable
 * condition rather than a thrown one. Carries `retryAfterSec` because honouring
 * it is the caller's obligation (see strategy note 3).
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
 * Declared here instead of in `types.ts` so the contract file stays the shared
 * seam it was built to be. It is assignable to `LoadedStems` and `missing` still
 * feeds `EngineSnapshot.degraded` untouched, so it is a widening, not a break —
 * though note there are currently NO production callers of `loadStems` (the
 * engine takes `StemSource[]` directly, per the contract), so that is a design
 * property and not evidence gathered from real consumers.
 *
 * A UI that wants to distinguish "the encoder never made vocals" from "the
 * signed-URL route was down mid-load" reads `refreshFailure`; one that does not,
 * ignores it. `null` on every clean load, and on a load degraded for ordinary
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
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;

  // Cheap gate: refuse before a single byte is read, and TERMINATE the response
  // rather than abandoning it — backpressure means nothing accumulates, but an
  // un-cancelled body holds the connection until the GC gets to it.
  if (Number.isFinite(declared) && declared > MAX_STEM_BYTES) {
    await body?.cancel?.().catch(() => {});
    return null;
  }

  if (!body || typeof body.getReader !== 'function') {
    // No readable stream (a shim or a test double). Nothing to count as we go,
    // so the after-the-fact check is the best available.
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0 && buf.byteLength <= MAX_STEM_BYTES ? buf : null;
  }

  // A usable Content-Length lets us read straight into ONE correctly-sized
  // buffer. Without it we must accumulate chunks and then assemble, which holds
  // the chunks AND the copy at the same time — so the transient peak is about
  // twice what we end up retaining. Pre-sizing removes that doubling for the
  // normal case (R2 always sends Content-Length on a GET).
  const presized = Number.isInteger(declared) && declared > 0 && declared <= MAX_STEM_BYTES;
  const out = presized ? new Uint8Array(declared) : null;
  const chunks: Uint8Array[] = [];

  const reader = body.getReader();
  let total = 0;
  let idleReads = 0;
  let reads = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `await reader.read()` settles as a MICROTASK when a value is already
      // queued, so a loop fed by an in-memory stream never reaches the macrotask
      // queue: timers do not fire, and the caller's AbortSignal.timeout — the
      // mitigation this module documents — could never run. Over real HTTP each
      // read waits on the socket and this is moot, but a non-conformant or
      // in-process source must not be able to starve the event loop. Yield
      // periodically so it always can.
      if ((++reads & 0x3ff) === 0) await new Promise((r) => setTimeout(r, 0));
      if (!value || value.byteLength === 0) {
        // Empty chunks never grow `total`, so the byte cap cannot bound them.
        // Bound the no-progress reads instead, and yield on every one of them:
        // this path is already abnormal, so fairness beats throughput here.
        if (++idleReads > MAX_IDLE_READS) {
          await reader.cancel().catch(() => {});
          return null;
        }
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      idleReads = 0;
      total += value.byteLength;
      // Truthful gate: stop the transfer and keep nothing.
      if (total > MAX_STEM_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      if (out) {
        // Content-Length said `declared`; a body longer than that is a
        // non-conformant response, and trusting it would overrun the buffer.
        if (total > declared) {
          await reader.cancel().catch(() => {});
          return null;
        }
        out.set(value, total - value.byteLength);
      } else {
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total === 0) return null; // an empty 200 is not a stem
  if (out) {
    // A body SHORTER than Content-Length is also non-conformant, but here the
    // bytes we did get are intact, so hand back exactly those.
    return total === declared ? out.buffer : out.buffer.slice(0, total);
  }
  const assembled = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    assembled.set(c, at);
    at += c.byteLength;
  }
  return assembled.buffer;
}

export async function loadStems(jobId: string, opts: LoadStemsOptions = {}): Promise<LoadStemsResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const outer = opts.signal;
  const throwIfAborted = () => {
    if (outer?.aborted) throw new StemLoadError('ABORTED', 'Stem loading was cancelled');
  };
  throwIfAborted();

  // Internal controller: the single signal every request in this load shares,
  // so the caller's abort reaches all of them. Nothing else aborts it — a
  // failure now degrades the load instead of cancelling its siblings.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });

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
     * The first nameable, non-abort failure that degraded this load: a manifest
     * refresh that failed for ANY reason, or a stem object that answered 429.
     * Recorded, never fatal — it must not cancel siblings that are already
     * downloading on URLs that still work. Boxed so that the assignments, which
     * happen inside nested closures, are visible to narrowing out here.
     */
    const refreshFail: { current: StemLoadError | null } = { current: null };
    const note = (e: StemLoadError) => {
      refreshFail.current ??= e;
    };

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
          // EVERY refresh failure is recorded, not just 429/404. A refresh that
          // 5xxs, fails the network or returns junk leaves the old URLs in
          // place, and those URLs are known-dead — the 403 is what sent us
          // here. Swallowing it meant `refreshFailure` stayed null and the UI
          // said "the encoder never made vocals" when the truth was "the URL
          // expired and the refresh route was down", which is exactly the
          // ambiguity this field exists to remove. Recording it also stops
          // `download` from re-fetching the dead URL for the rest of its
          // budget, since its guard now fires on the first 403.
          if (e instanceof StemLoadError) {
            // ABORTED needs no record: the caller already knows, and the final
            // throwIfAborted() turns it into the thrown ABORTED.
            if (e.code !== 'ABORTED') note(e);
          } else {
            note(new StemLoadError('MANIFEST_FAILED', 'Stems manifest refresh failed unexpectedly'));
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
          if (refreshFail.current || ctl.signal.aborted) return null;
          seen = generation;
          continue;
        }
        if (res.status === 429) {
          // The object store itself rate-limited us. The stem is still
          // `missing`, but a load where a rate limit demonstrably happened must
          // not report `refreshFailure: null` — that was a constructible case of
          // "too many requests" degrading silently.
          const ra = Number(res.headers?.get?.('retry-after'));
          note(
            new StemLoadError('RATE_LIMITED', 'Too many requests, try again shortly', {
              status: 429,
              retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
            }),
          );
          return null;
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

    const sources: StemSource[] = [];
    const missing: StemName[] = [];
    for (const r of results) {
      if (r.bytes) sources.push({ name: r.name, bytes: r.bytes });
      else missing.push(r.name);
    }
    // THE ZERO-SOURCE RULE, stated once so the code, this comment and the tests
    // agree:
    //   nothing loaded AND a nameable failure  -> throw it. Something broke that
    //     we can put a code on, and the caller needs that code plus
    //     `retryAfterSec` to decide when to come back.
    //   nothing loaded AND no nameable failure -> RETURN `{ sources: [],
    //     missing: all six, refreshFailure: null }`. The job legitimately has no
    //     playable stems (an encode produced none, every object 404s, or the
    //     bounded 403 retries ran out against a healthy manifest route). That is
    //     a job state, not a load error, so it stays a successful result —
    //     `engine.ts` maps it to PLAY_NO_STEMS.
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
    throwIfAborted();
    throw e;
  } finally {
    outer?.removeEventListener('abort', onAbort);
  }
}
