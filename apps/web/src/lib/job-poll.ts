/**
 * The job page's polling decisions, pulled out of `JobView` so they can be run
 * from node:test without a DOM.
 *
 * WHAT WAS WRONG. `JobView` did `setJob(await res.json())` with no `res.ok`
 * check, so a 5xx body (`{ error_code, message }`) was stored AS THE JOB. It has
 * no `status`, falls through every branch to the "Processing…" one, and renders
 * a blank stage label over "0%" — and because `undefined` is not terminal it
 * kept polling, forever. Separately, a job that is `queued` with no worker to
 * claim it is not touched by the reaper (see below), so the page said "Queued
 * 0%" until the 24h retention expired it.
 *
 * Two fixes live here: `readPoll` refuses to treat anything that is not a job as
 * one, and `jobStall` says when a non-terminal job has gone quiet for longer
 * than the pipeline itself can explain.
 */
import type { Job } from '@stem-loops/types';

export const POLL_MS = 2000;
/** After a failed poll. Matches the previous `POLL_MS * 2`. */
export const BACKOFF_POLL_MS = POLL_MS * 2;
/**
 * Consecutive failed polls (non-OK, network error, or a body that is not a job)
 * before the page stops and says so. 5 at 4 s back-off is ~16 s of silence after
 * the first failure: past a deploy blip, well short of a user giving up.
 */
/**
 * Consecutive failed polls (non-OK, network error, or a body that is not a job)
 * before the page SAYS SO. 5 at 4 s back-off is ~16 s of silence after the first
 * failure: past a deploy blip, well short of a user giving up.
 *
 * It is the threshold for the PANEL, not for stopping. The page keeps asking at
 * SLOW_POLL_MS afterwards, so a backend that comes back heals the page without a
 * click — see `UNREACHABLE/STALLED ARE PANELS, NOT STOPS` below.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * UNREACHABLE/STALLED ARE PANELS, NOT STOPS.
 *
 * The first version of this feature RETURNED from the effect on `unreachable`
 * and on `stalled`, which traded one lie for two:
 *   - a job queued behind another and finishing late showed "nothing has picked
 *     it up" and then never looked again, so the finished track never appeared;
 *   - five 500s during a deploy left "We can't get an update" on screen until
 *     the user clicked, where the previous version self-healed.
 * Both are now backed off, not stopped: the page keeps polling at this interval,
 * and `terminal`/`continue` clear the panel. 30 s is ~1/15th of the failed-poll
 * rate, cheap enough to leave running on a tab nobody is watching, short enough
 * that a recovery is on screen before a user who stepped away comes back.
 */
export const SLOW_POLL_MS = 30_000;

// ── where the stall thresholds come from ─────────────────────────────────────
// Every input below is a number the worker already defines. The separation
// ceiling is the DEPLOYED one (apps/worker/fly.toml), not the code default:
// deriving from the default is what produced the first version's 885 s, and the
// deployed value is 5.45x larger, so the page called healthy jobs stalled.
// `test/job-stall-derivation.test.mjs` reads fly.toml and every source line
// cited here and fails if any of them moves.
//
//   apps/worker/src/worker/reaper.py
//     STALE_SECONDS   = 300   (REAPER_STALE_SECONDS, :37)
//     MAX_ATTEMPTS    = 2     (REAPER_MAX_ATTEMPTS,  :44)
//     BACKOFF_FACTOR  = 2     (REAPER_BACKOFF_FACTOR,:45)
//     It acts only on status IN ('downloading','separating','extracting',
//     'uploading') (:47). It NEVER touches 'queued'.
//   apps/worker/src/worker/consumer.py
//     REAP_INTERVAL   = 60 s  (REAPER_INTERVAL_SECONDS, :39) — how often it looks.
//     POLL_INTERVAL   = 2 s   (:37) — an idle worker claims a queued job this fast.
//     The loop claims ONE job at a time (poll_loop: claim_and_run, sequentially).
const REAPER_STALE_S = 300;
const REAPER_BACKOFF = 2;
const REAPER_MAX_ATTEMPTS = 2;
const REAP_INTERVAL_S = 60;

/**
 * An ACTIVE job (downloading / separating / extracting / uploading) is stalled
 * once `updated_at` is older than the LONGEST window the reaper itself waits
 * before acting: it re-queues an orphan once stale for 300 * 2^attempts, and the
 * largest `attempts` it will still re-queue at is MAX_ATTEMPTS - 1 = 1, so 600 s,
 * plus up to one 60 s sweep to notice. 660 s. A live worker bumps `updated_at`
 * on every stage entry and, through separation and the two heart-beated stages,
 * every ~20 s, so a job older than this is one nothing is acting on.
 */
export const ACTIVE_STALL_MS = (REAPER_STALE_S * REAPER_BACKOFF ** (REAPER_MAX_ATTEMPTS - 1) + REAP_INTERVAL_S) * 1000;

// ── the queued threshold, derived against the DEPLOYED worker ────────────────
//
// A `queued` job is not touched by the reaper, so the only thing that ends its
// wait is the worker claiming it — and the worker runs ONE job at a time
// (consumer.poll_loop). So the question "how long may a queued job legitimately
// wait?" is "how long may the job ahead of it legitimately hold the worker?",
// and every stage of that job that is bounded by a constant is listed here.
//
// Mirrors of worker constants. Each is pinned to its source by
// `test/job-stall-derivation.test.mjs`; change one there and the test fails.

/** consumer.py:37 `POLL_INTERVAL = 2` — an idle worker claims a queued job this fast. */
const WORKER_CLAIM_POLL_S = 2;
/** pipeline.py:147 `FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT = 120.0`, applied at :230. */
const FFMPEG_DECODE_TIMEOUT_S = 120;
/**
 * apps/worker/fly.toml:21 `REPLICATE_DEADLINE = "300"` — the DEPLOYED value.
 * replicate_client.py:48 defaults it to 55, which is what the first version of
 * this file derived from and is wrong for every deployed environment.
 */
const REPLICATE_DEADLINE_S = 300;
/** pipeline.py:76 `SEPARATION_MAX_ATTEMPTS = 3`; the re-poll loop is at :1301. */
const SEPARATION_MAX_ATTEMPTS = 3;
/** pipeline.py:1114 `httpx.stream(..., timeout=180)` inside :1112 `for attempt in range(4)`. */
const STEM_FETCH_TIMEOUT_S = 180;
const STEM_FETCH_ATTEMPTS = 4;
/** pipeline.py:689 — the chord harmonic mix, `subprocess.run(..., timeout=300)`. */
const CHORD_MIX_TIMEOUT_S = 300;
/** chord_providers/klangio.py:108 `POLL_DEADLINE_SEC = 600`. */
const KLANGIO_POLL_DEADLINE_S = 600;
/** pipeline.py:508 `subprocess.run(..., timeout=300)` per stem. */
const STEM_OPUS_ENCODE_TIMEOUT_S = 300;
/** pipeline.py:459 `ALL_STEMS` — six, encoded SERIALLY in `retain_stems` (:563-566). */
const STEM_COUNT = 6;

/**
 * The longest one job can legitimately hold the worker, as the sum of the
 * stages the repo bounds with a constant. 4442 s = 74 min.
 *
 *   claim by an idle worker                2
 *   ffmpeg normalise of the upload       120
 *   separation polls   300 x 3           900   <- the deployed REPLICATE_DEADLINE
 *   fetch 6 stems      180 x 4           720   (6-wide pool, so one stem's budget)
 *   chord harmonic mix                   300
 *   chord recognition poll               600
 *   Opus encode        300 x 6          1800   (SERIAL, one subprocess per stem)
 *                                      -----
 *                                       4442
 *
 * TWO HONEST CAVEATS, because this is a floor on the ceiling and not the ceiling:
 *   1. `extract_and_tag` and the R2 PUTs are bounded by no constant at all, so
 *      they add an unknown amount.
 *   2. httpx's `timeout=180` is PER OPERATION, not per transfer: a response that
 *      delivers a byte every 179 s never trips it, so the 720 s row is a lower
 *      bound on its own worst case.
 * Both push the real ceiling UP, which is why the margin below is multiplicative
 * and why this threshold must never be tightened without new evidence.
 */
export const ONE_JOB_WORST_CASE_S =
  WORKER_CLAIM_POLL_S +
  FFMPEG_DECODE_TIMEOUT_S +
  REPLICATE_DEADLINE_S * SEPARATION_MAX_ATTEMPTS +
  STEM_FETCH_TIMEOUT_S * STEM_FETCH_ATTEMPTS +
  CHORD_MIX_TIMEOUT_S +
  KLANGIO_POLL_DEADLINE_S +
  STEM_OPUS_ENCODE_TIMEOUT_S * STEM_COUNT;

/** 20%, for the two unbounded stages above. */
export const QUEUED_STALL_MARGIN = 1.2;

/**
 * A QUEUED job is called stalled once it has waited longer than ONE job ahead of
 * it could legitimately take, plus margin, rounded UP to a whole five minutes so
 * the sentence the user reads is a round number: 5400 s = 90 minutes.
 *
 * WHY SO LATE. The panel asserts "nothing has picked it up". On a one-worker
 * deployment with ten beta testers, waiting behind another job is the NORMAL
 * case, and the previous 20-minute threshold made that assertion about jobs that
 * were perfectly healthy — fired on the common case, which is the opposite of
 * what a stall notice is for. Being late costs the user nothing now: the page
 * keeps polling (SLOW_POLL_MS) and renders the track the moment it lands,
 * whether or not this panel was shown. Being early costs them a false sentence.
 *
 * WHAT IT STILL DOES NOT MODEL: queue DEPTH. Two jobs ahead can legitimately
 * exceed this. The page's behaviour in that case is a panel that says it has
 * been a long time — true — beside a poll that is still running and will still
 * render the result.
 */
export const QUEUED_STALL_MS = Math.ceil((ONE_JOB_WORST_CASE_S * QUEUED_STALL_MARGIN) / 300) * 300 * 1000;

export type Stall = 'queued' | 'active';

const TERMINAL_STATUSES = new Set(['done', 'failed']);

/**
 * `null` while the job is fine or cannot be judged. `nowMs` should be the
 * SERVER's clock (see `PollOutcome.serverNowMs`): `updated_at` is the database's
 * clock, and a user's laptop can be minutes off.
 */
export function jobStall(job: { status?: unknown; updated_at?: unknown }, nowMs: number): Stall | null {
  if (typeof job.status !== 'string' || TERMINAL_STATUSES.has(job.status)) return null;
  const updated = typeof job.updated_at === 'string' ? Date.parse(job.updated_at) : NaN;
  if (!Number.isFinite(updated) || !Number.isFinite(nowMs)) return null;
  const age = nowMs - updated;
  if (job.status === 'queued') return age > QUEUED_STALL_MS ? 'queued' : null;
  return age > ACTIVE_STALL_MS ? 'active' : null;
}

export type PollOutcome =
  | { readonly kind: 'job'; readonly job: Job; readonly serverNowMs: number | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly status: number | null };

/**
 * Interpret one `GET /api/jobs/:id` response. Only a 2xx whose body is an object
 * with a string `id` and a string `status` is a job; a 404 is `missing` (the
 * route's own answer for gone / expired / malformed id); everything else —
 * 5xx, 429, a redirect to an HTML page, unparseable JSON, an error envelope — is
 * an `error` and is NEVER handed to the UI as if it were a job.
 */
export async function readPoll(res: Response): Promise<PollOutcome> {
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) return { kind: 'error', status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', status: res.status };
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { id?: unknown }).id !== 'string' ||
    typeof (body as { status?: unknown }).status !== 'string'
  ) {
    return { kind: 'error', status: res.status };
  }
  const date = Date.parse(res.headers?.get?.('date') ?? '');
  return { kind: 'job', job: body as Job, serverNowMs: Number.isFinite(date) ? date : null };
}

export type PollStep =
  /** The job is gone (404): show the not-found panel. */
  | { readonly action: 'missing'; readonly failures: number }
  /** A failed poll that has not yet used up its allowance: wait, ask again. */
  | { readonly action: 'retry'; readonly failures: number; readonly status: number | null }
  /**
   * `MAX_CONSECUTIVE_FAILURES` in a row: SAY SO — and keep asking slowly.
   * `status` is the last response's status, or `null` when there was no
   * response at all. The two are different sentences: a 500 means our server
   * answered and the user's connection is fine, and telling them to check it is
   * a lie about their own network.
   */
  | { readonly action: 'unreachable'; readonly failures: number; readonly status: number | null }
  /** A job in a terminal status (`done` / `failed`): render it and stop polling. */
  | { readonly action: 'terminal'; readonly failures: number; readonly job: Job }
  /** Non-terminal and quiet for longer than the pipeline explains: say so, keep asking slowly. */
  | { readonly action: 'stalled'; readonly failures: number; readonly job: Job; readonly stall: Stall }
  /** Non-terminal and healthy: show progress, poll again. */
  | { readonly action: 'continue'; readonly failures: number; readonly job: Job };

/**
 * The whole polling policy as one pure step, so the loop in `JobView` is only
 * "fetch, call this, apply the answer". `failures` is the count of consecutive
 * failed polls BEFORE this outcome; a good outcome resets it.
 */
export function nextPollStep(outcome: PollOutcome, failures: number, clientNowMs: number): PollStep {
  if (outcome.kind === 'missing') return { action: 'missing', failures: 0 };
  if (outcome.kind === 'error') {
    const n = failures + 1;
    return {
      action: n >= MAX_CONSECUTIVE_FAILURES ? 'unreachable' : 'retry',
      failures: n,
      status: outcome.status,
    };
  }
  const job = outcome.job;
  if (TERMINAL_STATUSES.has(job.status)) return { action: 'terminal', failures: 0, job };
  const stall = jobStall(job, outcome.serverNowMs ?? clientNowMs);
  if (stall) return { action: 'stalled', failures: 0, job, stall };
  return { action: 'continue', failures: 0, job };
}
