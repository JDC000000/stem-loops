// lib/job-poll.ts — what the job page does with a poll response, and when a job
// that is neither done nor failed has gone quiet for longer than the pipeline can
// explain. Pure; no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_STALL_MS,
  BACKOFF_POLL_MS,
  MAX_CONSECUTIVE_FAILURES,
  POLL_MS,
  QUEUED_STALL_MS,
  SLOW_POLL_MS,
  jobStall,
  nextPollStep,
  readPoll,
} from '../src/lib/job-poll.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(WEB, '..', 'worker', 'src', 'worker');

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const res = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const JOB = { id: 'abc', status: 'queued', updated_at: ago(0), events: [] };

// ── readPoll: a response that is not a job is never a job ─────────────────────

test('a 500 error envelope is an error, NOT a job (this was stored as the job and rendered "Processing… 0%")', async () => {
  const out = await readPoll(res({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, 500));
  assert.deepEqual(out, { kind: 'error', status: 500 });
});

test('every non-job response is an error: 502 html, 429, 200 envelope, 200 with no status, bad JSON, JSON null', async () => {
  const cases = [
    res('<html>Bad gateway</html>', 502, { 'content-type': 'text/html' }),
    res({ error_code: 'RATE_LIMITED' }, 429),
    res({ error_code: 'INTERNAL_ERROR', message: 'x' }, 200),
    res({ id: 'abc' }, 200),
    res({ status: 'queued' }, 200),
    res({ id: 'abc', status: 7 }, 200),
    res('not json', 200),
    res('null', 200),
    res('[]', 200),
  ];
  for (const r of cases) assert.equal((await readPoll(r)).kind, 'error', `${r.status}`);
});

test('a non-2xx is an error even when its body LOOKS like a job (the status line is checked, not just the shape)', async () => {
  assert.deepEqual(await readPoll(res({ id: 'abc', status: 'queued' }, 503)), { kind: 'error', status: 503 });
});

test('404 is "missing" (gone / expired / malformed id), distinct from an error', async () => {
  assert.deepEqual(await readPoll(res({ error_code: 'NOT_FOUND' }, 404)), { kind: 'missing' });
});

test('a real job parses, and the SERVER clock comes from the Date header when present', async () => {
  const withDate = await readPoll(res(JOB, 200, { date: new Date(NOW).toUTCString() }));
  assert.equal(withDate.kind, 'job');
  assert.equal(withDate.job.id, 'abc');
  assert.equal(withDate.serverNowMs, NOW);
  const without = await readPoll(res(JOB));
  assert.equal(without.serverNowMs, null);
});

// ── jobStall: thresholds and their provenance ────────────────────────────────

test('thresholds: ACTIVE = 300*2^(2-1)+60 s = 660 s, QUEUED = 90 min', () => {
  assert.equal(ACTIVE_STALL_MS, 660_000);
  // 90 min, derived in test/job-stall-derivation.test.mjs against the DEPLOYED
  // worker config. Stated as a literal here too, so a change to the derivation
  // that happens to still compile cannot move the user-visible number silently.
  assert.equal(QUEUED_STALL_MS, 5_400_000);
});

test('QUEUED stalls just past the threshold, not before', () => {
  assert.equal(jobStall({ status: 'queued', updated_at: ago(QUEUED_STALL_MS - 1000) }, NOW), null);
  assert.equal(jobStall({ status: 'queued', updated_at: ago(QUEUED_STALL_MS + 1000) }, NOW), 'queued');
});

test('every ACTIVE status stalls just past 11 min, not before', () => {
  for (const status of ['downloading', 'separating', 'extracting', 'uploading']) {
    assert.equal(jobStall({ status, updated_at: ago(ACTIVE_STALL_MS - 1000) }, NOW), null, status);
    assert.equal(jobStall({ status, updated_at: ago(ACTIVE_STALL_MS + 1000) }, NOW), 'active', status);
  }
});

test('done / failed / unknown-shaped jobs are never "stalled"', () => {
  const old = ago(24 * 60 * MIN);
  assert.equal(jobStall({ status: 'done', updated_at: old }, NOW), null);
  assert.equal(jobStall({ status: 'failed', updated_at: old }, NOW), null);
  assert.equal(jobStall({ updated_at: old }, NOW), null);
  assert.equal(jobStall({ status: 'queued', updated_at: 'garbage' }, NOW), null);
  assert.equal(jobStall({ status: 'queued' }, NOW), null);
  assert.equal(jobStall({ status: 'queued', updated_at: old }, Number.NaN), null);
});

test('an updated_at in the FUTURE (clock skew) is not a stall', () => {
  assert.equal(jobStall({ status: 'queued', updated_at: ago(-10 * MIN) }, NOW), null);
});

// ── the numbers the thresholds cite are still the worker's numbers ───────────
// If any of these change, the derivation in job-poll.ts is stale and must be
// revisited — most importantly if the reaper starts rescuing 'queued'.

test('worker constants cited by job-poll.ts have not moved', () => {
  const reaper = readFileSync(join(WORKER, 'reaper.py'), 'utf8');
  const consumer = readFileSync(join(WORKER, 'consumer.py'), 'utf8');
  assert.match(reaper, /"REAPER_STALE_SECONDS",\s*"300"/);
  assert.match(reaper, /"REAPER_MAX_ATTEMPTS",\s*"2"/);
  assert.match(reaper, /"REAPER_BACKOFF_FACTOR",\s*"2"/);
  assert.match(consumer, /"REAPER_INTERVAL_SECONDS",\s*"60"/);
  const nonTerminal = reaper.match(/_NON_TERMINAL\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
  assert.deepEqual(
    [...nonTerminal.matchAll(/"([a-z]+)"/g)].map((m) => m[1]),
    ['downloading', 'separating', 'extracting', 'uploading'],
    "the reaper's rescue set changed: if it now includes 'queued' the QUEUED threshold is the wrong tool",
  );
});

// ── nextPollStep: the policy, as sequences ────────────────────────────────────

const ERR = { kind: 'error', status: 500 };
const okJob = (over = {}) => ({ kind: 'job', job: { ...JOB, ...over }, serverNowMs: NOW });

test('4 failures retry, the 5th is "unreachable"; the job is never set from a failure', () => {
  let f = 0;
  for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
    const step = nextPollStep(ERR, f, NOW);
    assert.equal(step.action, 'retry', `failure ${i}`);
    assert.equal('job' in step, false, 'a failure must never carry a job');
    f = step.failures;
  }
  assert.equal(nextPollStep(ERR, f, NOW).action, 'unreachable');
});

test('a success in the middle resets the count', () => {
  let f = 0;
  for (let i = 0; i < 4; i++) f = nextPollStep(ERR, f, NOW).failures;
  const good = nextPollStep(okJob({ updated_at: ago(0) }), f, NOW);
  assert.equal(good.action, 'continue');
  assert.equal(good.failures, 0);
  assert.equal(nextPollStep(ERR, good.failures, NOW).action, 'retry');
});

test('terminal statuses stop; missing stops; a healthy job continues', () => {
  assert.equal(nextPollStep(okJob({ status: 'done' }), 0, NOW).action, 'terminal');
  assert.equal(nextPollStep(okJob({ status: 'failed' }), 0, NOW).action, 'terminal');
  assert.equal(nextPollStep({ kind: 'missing' }, 3, NOW).action, 'missing');
  assert.equal(nextPollStep(okJob({ status: 'separating' }), 0, NOW).action, 'continue');
});

test('a queued job with no worker: continues until 90 min, then STALLS (the "Queued 0%" forever case)', () => {
  assert.equal(nextPollStep(okJob({ status: 'queued', updated_at: ago(89 * MIN) }), 0, NOW).action, 'continue');
  const s = nextPollStep(okJob({ status: 'queued', updated_at: ago(91 * MIN) }), 0, NOW);
  assert.equal(s.action, 'stalled');
  assert.equal(s.stall, 'queued');
});

test('THE BETA BLOCKER: a job queued behind ONE other job is healthy, not stalled', () => {
  // The first version of this feature derived 885 s from replicate_client.py's
  // CODE DEFAULT of 55 s and called anything past 20 min stalled. The deployed
  // REPLICATE_DEADLINE is 300 (apps/worker/fly.toml), so one job ahead can
  // legitimately hold the single worker for 74 min, and on a ten-tester beta
  // queueing behind one job is the NORMAL case. Every minute here must be
  // "continue", or the panel is asserting "nothing has picked it up" about a
  // job that is being worked on right now.
  for (const min of [5, 19, 21, 30, 45, 60, 74, 88]) {
    const step = nextPollStep(okJob({ status: 'queued', updated_at: ago(min * MIN) }), 0, NOW);
    assert.equal(step.action, 'continue', `a job queued ${min} min is NOT stalled`);
  }
});

test('the server clock wins over a wrong client clock; the client clock is the fallback', () => {
  const stale = { ...JOB, status: 'queued', updated_at: ago(100 * MIN) };
  // client clock 2 days behind would see the job as "from the future" -> never stalled
  const behind = NOW - 2 * 24 * 60 * MIN;
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: NOW }, 0, behind).action, 'stalled');
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: null }, 0, behind).action, 'continue');
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: null }, 0, NOW).action, 'stalled');
});

test('poll cadence: 2 s, 4 s after a failure, 30 s once a panel is up', () => {
  assert.equal(POLL_MS, 2000);
  assert.equal(BACKOFF_POLL_MS, 4000);
  // The slow poll is what makes `stalled` and `unreachable` panels rather than
  // stops. A mutant that deletes it is killed by test/job-view-poll.test.mjs;
  // this pins the number so it cannot drift to something unusable (a 30-minute
  // slow poll would be a stop with extra steps).
  assert.equal(SLOW_POLL_MS, 30_000);
  assert.ok(SLOW_POLL_MS >= POLL_MS, 'the slow poll must be slower than the healthy one');
  assert.ok(SLOW_POLL_MS <= 60_000, 'a slow poll over a minute is a stop with extra steps');
});

// ── the failure budget, pinned as a literal ──────────────────────────────────

test('MAX_CONSECUTIVE_FAILURES is 5 — the loops above count it, so the constant itself needs pinning', () => {
  // Every sequence test in this file iterates to MAX_CONSECUTIVE_FAILURES, so
  // raising it to 50 keeps them all green while the user stares at a blank
  // "Processing…" for 200 s instead of 16 s. The literal is the only thing that
  // catches that.
  assert.equal(MAX_CONSECUTIVE_FAILURES, 5);
  // Stated as behaviour as well: exactly four retries, then the panel.
  let f = 0;
  const actions = [];
  for (let i = 0; i < 6; i++) {
    const step = nextPollStep(ERR, f, NOW);
    actions.push(step.action);
    f = step.failures;
  }
  assert.deepEqual(actions, ['retry', 'retry', 'retry', 'retry', 'unreachable', 'unreachable']);
});

// ── "unreachable" is not a synonym for 500 ───────────────────────────────────

test('ANY failed poll counts toward unreachable, not only a 500', () => {
  // A mutant that fires `unreachable` only on `status === 500` survives every
  // sequence test above, because they all use a 500. These do not.
  const kinds = [
    { kind: 'error', status: null, what: 'fetch rejected (offline / DNS / CORS)' },
    { kind: 'error', status: 502, what: 'bad gateway' },
    { kind: 'error', status: 503, what: 'service unavailable' },
    { kind: 'error', status: 429, what: 'rate limited' },
    { kind: 'error', status: 200, what: '200 whose body is not a job' },
  ];
  for (const { what, ...outcome } of kinds) {
    let f = 0;
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const step = nextPollStep(outcome, f, NOW);
      assert.equal(step.action, 'retry', `${what}: failure ${i}`);
      f = step.failures;
    }
    const last = nextPollStep(outcome, f, NOW);
    assert.equal(last.action, 'unreachable', what);
    assert.equal(last.status, outcome.status, `${what}: the status must reach the UI`);
  }
});

test('the failing status reaches the step, so the panel can stop saying "check your connection" to a 500', () => {
  assert.equal(nextPollStep({ kind: 'error', status: 500 }, 0, NOW).status, 500);
  assert.equal(nextPollStep({ kind: 'error', status: null }, 0, NOW).status, null);
});

// ── the exact boundary, so `>` cannot become `>=` ────────────────────────────

test('the stall comparison is strictly greater-than: AT the threshold a job is still healthy', () => {
  // `>` -> `>=` is a one-millisecond mutation that no other test in this file
  // can see, because they all probe a second either side.
  assert.equal(jobStall({ status: 'queued', updated_at: ago(QUEUED_STALL_MS) }, NOW), null, 'queued, exactly at');
  assert.equal(jobStall({ status: 'queued', updated_at: ago(QUEUED_STALL_MS + 1) }, NOW), 'queued', 'queued, 1 ms past');
  assert.equal(jobStall({ status: 'separating', updated_at: ago(ACTIVE_STALL_MS) }, NOW), null, 'active, exactly at');
  assert.equal(jobStall({ status: 'separating', updated_at: ago(ACTIVE_STALL_MS + 1) }, NOW), 'active', 'active, 1 ms past');
});
