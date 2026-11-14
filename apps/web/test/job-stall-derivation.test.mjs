// The QUEUED stall threshold, pinned to the DEPLOYED worker — not to a code default.
//
// WHY THIS FILE EXISTS. The first version of the stall panel derived its
// threshold as 885 s and surfaced "nothing has picked it up" at 20 minutes. The
// derivation summed `replicate_client.py`'s HARD_DEADLINE, read as its CODE
// DEFAULT of 55 s. Production does not run that: `apps/worker/fly.toml` sets
// `REPLICATE_DEADLINE = "300"`, 5.45x larger, so the separation row alone was
// out by 735 s. The result was a page that told a user nothing had picked up a
// job that a worker was, at that moment, separating.
//
// Review also demonstrated the instrument failure behind it: the PR claimed
// "there is a test that fails if they move", and moving REPLICATE_DEADLINE
// 55 -> 550, KLANGIO_POLL_DEADLINE_SEC 600 -> 6000 and the ffmpeg default
// 120 -> 1200 in the worker source left the whole suite green. Nothing read
// fly.toml at all.
//
// So this file reads the REAL files — fly.toml first — extracts every number the
// derivation in src/lib/job-poll.ts cites, and recomputes the threshold from
// them. A future change to the deployed REPLICATE_DEADLINE, to the number of
// separation attempts, to the Klangio poll deadline, to the ffmpeg budgets or to
// the stem count breaks a test here instead of breaking the UX silently.
//
// WHAT IT IS NOT. It is not a claim that 4442 s is the true ceiling. Two stages
// (`extract_and_tag`, the R2 PUTs) are bounded by no constant at all, and
// httpx's `timeout=180` is per-operation rather than per-transfer, so the real
// ceiling is HIGHER. That is why the threshold carries a multiplicative margin
// and why the assertions below are "the threshold is at least the derivation",
// never "at most".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONE_JOB_WORST_CASE_S,
  QUEUED_STALL_MARGIN,
  QUEUED_STALL_MS,
  jobStall,
} from '../src/lib/job-poll.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(WEB, '..', 'worker');
const read = (p) => readFileSync(join(WORKER, p), 'utf8');

const FLY = read('fly.toml');
const REPLICATE = read('src/worker/replicate_client.py');
const PIPELINE = read('src/worker/pipeline.py');
const KLANGIO = read('src/worker/chord_providers/klangio.py');
const CONSUMER = read('src/worker/consumer.py');

/** The one match of `re` in `src`, as a number. Fails loudly when the shape moved. */
function one(src, re, what) {
  const all = [...src.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  assert.equal(all.length, 1, `expected exactly one ${what}, found ${all.length} — the derivation in src/lib/job-poll.ts cites it by shape and can no longer find it`);
  const n = Number(all[0][1]);
  assert.ok(Number.isFinite(n), `${what} is not a number: ${all[0][1]}`);
  return n;
}

// ── 1. the deployed separation ceiling ───────────────────────────────────────

test('THE BUG: the deployed REPLICATE_DEADLINE is read from fly.toml, not from the code default', () => {
  const deployed = one(FLY, /^\s*REPLICATE_DEADLINE\s*=\s*"(\d+)"/m, 'REPLICATE_DEADLINE in fly.toml');
  const codeDefault = one(REPLICATE, /HARD_DEADLINE = int\(os\.environ\.get\("REPLICATE_DEADLINE", "(\d+)"\)\)/, 'the HARD_DEADLINE default');

  assert.equal(deployed, 300, 'fly.toml changed REPLICATE_DEADLINE: re-derive QUEUED_STALL_MS in src/lib/job-poll.ts');
  // The two differing is the whole point. If they ever converge this assertion
  // should be deleted, not "fixed" — but while they differ, deriving from the
  // code default is the defect this file exists to stop.
  assert.notEqual(
    deployed,
    codeDefault,
    'fly.toml and the code default now agree; the derivation must still cite fly.toml, which is what ships',
  );
});

// ── 2. every other number the derivation cites ───────────────────────────────

const CITED = {
  WORKER_CLAIM_POLL_S: () => one(CONSUMER, /^POLL_INTERVAL = (\d+)\s+# seconds/m, 'consumer POLL_INTERVAL'),
  FFMPEG_DECODE_TIMEOUT_S: () => one(PIPELINE, /^FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT = ([\d.]+)/m, 'FFMPEG_DECODE_TIMEOUT_SEC_DEFAULT'),
  REPLICATE_DEADLINE_S: () => one(FLY, /^\s*REPLICATE_DEADLINE\s*=\s*"(\d+)"/m, 'REPLICATE_DEADLINE in fly.toml'),
  SEPARATION_MAX_ATTEMPTS: () => one(PIPELINE, /^SEPARATION_MAX_ATTEMPTS = int\(os\.environ\.get\("SEPARATION_MAX_ATTEMPTS", "(\d+)"\)\)/m, 'SEPARATION_MAX_ATTEMPTS'),
  STEM_FETCH_TIMEOUT_S: () => one(PIPELINE, /httpx\.stream\("GET", url, timeout=(\d+), follow_redirects=True\)/, 'the per-stem download timeout'),
  STEM_FETCH_ATTEMPTS: () => one(PIPELINE, /for attempt in range\((\d+)\):\n\s+try:\n\s+with httpx\.stream\("GET", url/, 'the per-stem download retry count'),
  CHORD_MIX_TIMEOUT_S: () => one(PIPELINE, /proc = subprocess\.run\(cmd, capture_output=True, text=True, timeout=(\d+)\)/, 'the chord harmonic-mix ffmpeg timeout'),
  KLANGIO_POLL_DEADLINE_S: () => one(KLANGIO, /^POLL_DEADLINE_SEC = float\(os\.environ\.get\("KLANGIO_POLL_DEADLINE_SEC", "(\d+)"\)\)/m, 'POLL_DEADLINE_SEC'),
  STEM_OPUS_ENCODE_TIMEOUT_S: () => one(PIPELINE, /proc = subprocess\.run\(cmd, capture_output=True, timeout=(\d+), check=False\)/, 'the per-stem Opus encode timeout'),
};

const EXPECTED = {
  WORKER_CLAIM_POLL_S: 2,
  FFMPEG_DECODE_TIMEOUT_S: 120,
  REPLICATE_DEADLINE_S: 300,
  SEPARATION_MAX_ATTEMPTS: 3,
  STEM_FETCH_TIMEOUT_S: 180,
  STEM_FETCH_ATTEMPTS: 4,
  CHORD_MIX_TIMEOUT_S: 300,
  KLANGIO_POLL_DEADLINE_S: 600,
  STEM_OPUS_ENCODE_TIMEOUT_S: 300,
};

test('every worker constant the derivation cites still has the value it was derived from', () => {
  for (const [name, extract] of Object.entries(CITED)) {
    assert.equal(
      extract(),
      EXPECTED[name],
      `${name} moved in the worker. QUEUED_STALL_MS in src/lib/job-poll.ts was derived from the old value — re-derive it.`,
    );
  }
});

test('the stem count the encode row multiplies by is the real ALL_STEMS, and they are encoded SERIALLY', () => {
  const stems = PIPELINE.match(/^ALL_STEMS = \(([^)]*)\)/m)?.[1] ?? '';
  const names = [...stems.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['vocals', 'drums', 'bass', 'other', 'guitar', 'keys']);
  assert.equal(names.length, 6, 'the Opus-encode row multiplies the per-stem timeout by six');
  // Serial, not pooled: `retain_stems` is a plain for-loop over sorted(stem_paths).
  // If it ever becomes a ThreadPoolExecutor the 6x row collapses to 1x and the
  // threshold may be lowered — which is a deliberate decision, not a silent one.
  const retain = PIPELINE.match(/def retain_stems\([^)]*\)[^\n]*\n([\s\S]*?)\ndef /)?.[1] ?? '';
  assert.match(retain, /for name, path in sorted\(stem_paths\.items\(\)\):/, 'retain_stems is no longer a serial loop');
  assert.doesNotMatch(retain, /ThreadPoolExecutor/, 'retain_stems now pools the encodes: the x6 row is stale');
});

// ── 3. the arithmetic, recomputed from what was just read ────────────────────

test('ONE_JOB_WORST_CASE_S is exactly the sum of the stages read out of the worker', () => {
  const v = Object.fromEntries(Object.entries(CITED).map(([k, f]) => [k, f()]));
  const derived =
    v.WORKER_CLAIM_POLL_S +
    v.FFMPEG_DECODE_TIMEOUT_S +
    v.REPLICATE_DEADLINE_S * v.SEPARATION_MAX_ATTEMPTS +
    v.STEM_FETCH_TIMEOUT_S * v.STEM_FETCH_ATTEMPTS +
    v.CHORD_MIX_TIMEOUT_S +
    v.KLANGIO_POLL_DEADLINE_S +
    v.STEM_OPUS_ENCODE_TIMEOUT_S * 6;

  assert.equal(derived, 4442, 'the arithmetic in the job-poll.ts comment is stale');
  assert.equal(
    ONE_JOB_WORST_CASE_S,
    derived,
    'src/lib/job-poll.ts no longer sums to what the worker actually bounds — its mirrored constants have drifted',
  );
});

test('QUEUED_STALL_MS is the derivation plus margin, and 90 minutes is what the user is told', () => {
  assert.equal(QUEUED_STALL_MARGIN, 1.2);
  assert.ok(
    QUEUED_STALL_MS >= ONE_JOB_WORST_CASE_S * 1000,
    `the threshold (${QUEUED_STALL_MS} ms) is BELOW the worst case one job ahead can legitimately take ` +
      `(${ONE_JOB_WORST_CASE_S * 1000} ms): the panel would fire on healthy jobs, which is the defect it was re-derived to fix`,
  );
  assert.equal(QUEUED_STALL_MS, Math.ceil((ONE_JOB_WORST_CASE_S * QUEUED_STALL_MARGIN) / 300) * 300 * 1000);
  assert.equal(QUEUED_STALL_MS, 5_400_000);
  assert.equal(Math.round(QUEUED_STALL_MS / 60_000), 90, 'the panel names this many minutes');
});

test('the 885 s derivation this replaced would now be rejected by the assertion above', () => {
  // The old number, stated once so the regression has a name. 885 s is less than
  // a fifth of what one job can legitimately take on the deployed worker.
  const OLD_DERIVATION_S = 120 + 55 * 3 + 600;
  assert.equal(OLD_DERIVATION_S, 885);
  assert.ok(OLD_DERIVATION_S * 1000 < ONE_JOB_WORST_CASE_S * 1000);
  // And the behaviour that followed from it: a job queued 21 minutes — one job
  // ahead, mid-separation — was called stalled.
  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const at = (min) => ({ status: 'queued', updated_at: new Date(NOW - min * 60_000).toISOString() });
  assert.equal(jobStall(at(21), NOW), null, 'still the old threshold: a healthy queued job is called stalled');
  assert.equal(jobStall(at(91), NOW), 'queued');
});
