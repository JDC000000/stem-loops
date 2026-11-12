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
export const MAX_CONSECUTIVE_FAILURES = 5;

// ── where the stall thresholds come from ─────────────────────────────────────
// Every input is a number the worker already defines; none is invented here.
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
 * on every stage entry and every ~20 s through the long stages, so a job older
 * than this is one nothing is acting on — either no reaper is running, or the
 * worker is wedged in a way that still holds the job.
 */
export const ACTIVE_STALL_MS = (REAPER_STALE_S * REAPER_BACKOFF ** (REAPER_MAX_ATTEMPTS - 1) + REAP_INTERVAL_S) * 1000;

/**
 * A QUEUED job is stalled after 20 minutes. This one is a judgement bounded by
 * evidence, not a derivation: the reaper does not rescue `queued`, so only the
 * worker claiming it ends the wait, and the worker runs one job at a time. The
 * longest time one job can legitimately hold it is the sum of its bounded
 * stages — ffmpeg decode 120 s (pipeline.py FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT),
 * separation 55 s x 3 attempts = 165 s (replicate_client.py HARD_DEADLINE x
 * SEPARATION_MAX_ATTEMPTS), chord recognition up to 600 s (klangio.py
 * POLL_DEADLINE_SEC) = 885 s, plus un-bounded-by-constant download and upload
 * time. 20 min is one such job ahead of you, with slack. If a queue routinely
 * runs deeper than one job, raise this — it is the one number here the repo
 * cannot settle.
 */
export const QUEUED_STALL_MS = 20 * 60 * 1000;

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
  | { readonly action: 'retry'; readonly failures: number }
  /** `MAX_CONSECUTIVE_FAILURES` in a row: stop, and say so. */
  | { readonly action: 'unreachable'; readonly failures: number }
  /** A job in a terminal status (`done` / `failed`): render it and stop polling. */
  | { readonly action: 'terminal'; readonly failures: number; readonly job: Job }
  /** Non-terminal and quiet for longer than the pipeline explains: stop, and say so. */
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
    return { action: n >= MAX_CONSECUTIVE_FAILURES ? 'unreachable' : 'retry', failures: n };
  }
  const job = outcome.job;
  if (TERMINAL_STATUSES.has(job.status)) return { action: 'terminal', failures: 0, job };
  const stall = jobStall(job, outcome.serverNowMs ?? clientNowMs);
  if (stall) return { action: 'stalled', failures: 0, job, stall };
  return { action: 'continue', failures: 0, job };
}
