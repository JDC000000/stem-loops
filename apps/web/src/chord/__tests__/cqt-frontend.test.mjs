import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  CQT_PLAN_URL,
  EXPECTED_CQT_PLAN_SHA256,
  __resetCqtPlanCacheForTests,
  assertCQTParity,
  computeCQT,
  loadCqtPlan,
} from '../cqt-frontend.ts';

function canonicalJson(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(x).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(x[k])).join(',') +
    '}'
  );
}

function makeFetch(body, ok = true, status = 200) {
  return async (url) => {
    assert.equal(url, CQT_PLAN_URL);
    return {
      ok,
      status,
      async text() {
        return body;
      },
    };
  };
}

test('committed plan JSON hashes to EXPECTED_CQT_PLAN_SHA256', () => {
  // Read the actual committed file and verify its canonical hash.
  const raw = readFileSync(
    new URL('../../../public/cqt-plan.v1.json', import.meta.url),
  );
  const parsed = JSON.parse(raw.toString('utf8'));
  const sha = createHash('sha256')
    .update(canonicalJson(parsed))
    .digest('hex');
  assert.equal(sha, EXPECTED_CQT_PLAN_SHA256);
});

test('loadCqtPlan: happy path + cache', async () => {
  __resetCqtPlanCacheForTests();
  const raw = readFileSync(
    new URL('../../../public/cqt-plan.v1.json', import.meta.url),
  ).toString('utf8');
  let hits = 0;
  const f = async () => {
    hits++;
    return {
      ok: true,
      status: 200,
      async text() {
        return raw;
      },
    };
  };
  const p1 = await loadCqtPlan(f);
  const p2 = await loadCqtPlan(f);
  assert.equal(p1, p2, 'cached reference identity');
  assert.equal(hits, 1, 'second call is cached');
  assert.equal(p1.sr, 22050);
  assert.equal(p1.n_bins, 144);
});

test('loadCqtPlan: sha mismatch throws with actionable message', async () => {
  __resetCqtPlanCacheForTests();
  const body = JSON.stringify({
    version: 'v1',
    sr: 22050,
    hop: 2048,
    fmin: 32.7,
    n_bins: 144,
    bins_per_octave: 24,
    mag: 'log',
    znorm: 'global',
    znorm_mean: 0.0,
    znorm_std: 2.0, // <-- mutated
  });
  await assert.rejects(
    () => loadCqtPlan(makeFetch(body)),
    /sha mismatch/,
  );
});

test('loadCqtPlan: fetch failure throws', async () => {
  __resetCqtPlanCacheForTests();
  await assert.rejects(
    () => loadCqtPlan(makeFetch('', false, 404)),
    /failed: 404/,
  );
});

test('computeCQT: silence produces a finite, uniform low-floor output', async () => {
  __resetCqtPlanCacheForTests();
  const raw = readFileSync(
    new URL('../../../public/cqt-plan.v1.json', import.meta.url),
  ).toString('utf8');
  const f = async () => ({
    ok: true,
    status: 200,
    async text() {
      return raw;
    },
  });
  await loadCqtPlan(f);
  const sr = 22050;
  const audio = new Float32Array(sr); // 1s of silence
  const { frames, nFrames } = await computeCQT(audio);
  assert.ok(nFrames > 0, 'should produce at least one frame');
  // All values finite, all roughly equal (silence = log(EPS))
  const first = frames[0];
  for (let i = 0; i < frames.length; i++) {
    assert.ok(Number.isFinite(frames[i]), `non-finite value at ${i}`);
    assert.ok(
      Math.abs(frames[i] - first) < 1e-3,
      `silence CQT should be uniform, got ${frames[i]} vs ${first}`,
    );
  }
});

test('computeCQT: sine wave at a known bin frequency lights up that bin', async () => {
  __resetCqtPlanCacheForTests();
  const raw = readFileSync(
    new URL('../../../public/cqt-plan.v1.json', import.meta.url),
  ).toString('utf8');
  const f = async () => ({
    ok: true,
    status: 200,
    async text() {
      return raw;
    },
  });
  const plan = await loadCqtPlan(f);
  const sr = plan.sr;
  // Pick a mid-range bin so we're not near the edges where the window length
  // is capped. n_bins=144, bpo=24 → one octave is 24 bins. Bin 60 ≈ 2.5 oct
  // above fmin 32.7 → 32.7 * 2^(60/24) ≈ 184.9 Hz.
  const targetBin = 60;
  const fTarget =
    plan.fmin * Math.pow(2, targetBin / plan.bins_per_octave);
  const N = 2 * sr; // 2s of audio for plenty of frames
  const audio = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    audio[n] = Math.sin((2 * Math.PI * fTarget * n) / sr);
  }
  const { frames, nFrames } = await computeCQT(audio);
  assert.ok(nFrames >= 2);
  // Pick a middle frame (avoid any transient at boundaries).
  const midFrame = Math.floor(nFrames / 2);
  const slice = frames.slice(
    midFrame * plan.n_bins,
    (midFrame + 1) * plan.n_bins,
  );
  let argmax = 0;
  for (let k = 1; k < slice.length; k++) {
    if (slice[k] > slice[argmax]) argmax = k;
  }
  // Tolerate ±2 bins; neighbouring Q filters overlap and the peak can drift.
  assert.ok(
    Math.abs(argmax - targetBin) <= 2,
    `expected peak near bin ${targetBin}, got ${argmax}`,
  );
});

test('assertCQTParity: in-range returns ok=true', () => {
  const a = new Float32Array([0, 1, 2, 3]);
  const b = new Float32Array([0.0005, 1.0005, 2.0005, 3.0005]);
  const res = assertCQTParity(a, b, 1e-3);
  assert.equal(res.ok, true);
  assert.ok(res.maxDiff <= 1e-3);
});

test('assertCQTParity: length mismatch returns ok=false', () => {
  const res = assertCQTParity(
    new Float32Array([0, 1]),
    new Float32Array([0, 1, 2]),
  );
  assert.equal(res.ok, false);
  assert.equal(res.maxDiff, Infinity);
});
