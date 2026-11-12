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

test('thresholds: ACTIVE = 300*2^(2-1)+60 s = 660 s, QUEUED = 20 min', () => {
  assert.equal(ACTIVE_STALL_MS, 660_000);
  assert.equal(QUEUED_STALL_MS, 1_200_000);
});

test('QUEUED stalls just past 20 min, not before', () => {
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

test('a queued job with no worker: continues until 20 min, then STALLS (the "Queued 0%" forever case)', () => {
  assert.equal(nextPollStep(okJob({ status: 'queued', updated_at: ago(19 * MIN) }), 0, NOW).action, 'continue');
  const s = nextPollStep(okJob({ status: 'queued', updated_at: ago(21 * MIN) }), 0, NOW);
  assert.equal(s.action, 'stalled');
  assert.equal(s.stall, 'queued');
});

test('the server clock wins over a wrong client clock; the client clock is the fallback', () => {
  const stale = { ...JOB, status: 'queued', updated_at: ago(30 * MIN) };
  // client clock 2 days behind would see the job as "from the future" -> never stalled
  const behind = NOW - 2 * 24 * 60 * MIN;
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: NOW }, 0, behind).action, 'stalled');
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: null }, 0, behind).action, 'continue');
  assert.equal(nextPollStep({ kind: 'job', job: stale, serverNowMs: null }, 0, NOW).action, 'stalled');
});

test('poll cadence is unchanged: 2 s, 4 s after a failure', () => {
  assert.equal(POLL_MS, 2000);
  assert.equal(BACKOFF_POLL_MS, 4000);
});
