// Chord playhead — the defects an independent review of #187 reproduced.
//
// #187 shipped the playhead at 89/100 against a 90 gate. These tests pin the
// four findings that cost it those points, so none of them can come back:
//
//   F2 (High) THE HINT WAS NOT A PURE ACCELERATOR. `activeRunIndex` documented
//      that "a stale, absent or hostile hint changes the cost and never the
//      answer". That holds only for runs sorted by startSec with no overlaps,
//      and NOTHING produced that: `toObservations` copies the worker's segments
//      through in wire order, `observationsToRuns` did not reorder them, and
//      the ChordSource contract requires neither. A fuzz over 20,000 hostile
//      datasets found 18,126 on which the hint changed the answer.
//   F1 (Med) THE PER-FRAME COST CLAIM WAS OVERSTATED. The chips were memoised,
//      but a frame still re-walked the runs through `durationSec` and
//      `timelineWidthPx` and rebuilt every ruler tick.
//   F3 (Low) The zoom effect recorded the scrollLeft it ASKED for, not the one
//      the element took after the browser's clamp, so a zoom near the end of
//      the track could read as a manual scroll and suspend auto-follow.
//   F5 (Low) The "Now ..." row was mounted only while a chord was sounding, so
//      the layout jumped as playback crossed a gap between chords.
//
// Fixtures here are deliberately NOT the ones #187 used. That fixture quantises
// every boundary to the worker's 0.1 s grid, and 0.1 s is exactly 6 frames at
// 60 fps, so every boundary sits at the SAME phase relative to a frame — the
// one alignment where an off-by-one in frame-to-chord mapping is invisible.
// Two fixtures replace it: the repo's committed play-chords artifact golden
// (real shape, through the real loader), and a 159-segment track whose
// boundaries are irrationally spaced so boundary phase is dense in [0, 1).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { collapseRuns } from '../src/chord/smoother.ts';
import { fetchPlayChords } from '../src/chord/play-chords-loader.ts';
import {
  activeRunIndex,
  durationSec,
  hasMonotoneRunsMark,
  isManualScroll,
  markMonotoneRuns,
  observationsToRuns,
  playheadGeometry,
  rulerTicks,
  runFramesAreMonotone,
  runsAreMonotone,
  timelineWidthPx,
  PX_PER_SEC,
} from '../src/components/ChordOverlay.helpers.ts';

const WEB = join(import.meta.dirname, '..');
const OVERLAY_TSX = readFileSync(join(WEB, 'src/components/ChordOverlay.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// Fixture A — the committed artifact golden, through the REAL loader
// ---------------------------------------------------------------------------
//
// fixtures/contracts/play-chords.golden.json is the bytes the worker's real
// upload path produces, captured and committed by
// apps/worker/tests/test_chord_golden_contract.py. It is the only
// Klangio-shaped artifact in the repo: real field names, real provider name,
// a slash chord (G:7/5) and sub-1.0 confidences. The VALUES are a fixture, not
// a captured production response — no captured Klangio response is committed
// here — but the SHAPE is the contract, and this test reaches it through the
// loader's own snake_case -> camelCase mapping rather than restating it.

const GOLDEN = JSON.parse(
  readFileSync(join(WEB, '..', '..', 'fixtures', 'contracts', 'play-chords.golden.json'), 'utf8'),
);

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serve the envelope, then `payload`, the way the two-tier loader expects. */
function serve(payload) {
  let i = 0;
  globalThis.fetch = async () => {
    i += 1;
    const json = i === 1 ? { signed_url: 'https://r2.example.com/x?sig=y', expires_in_sec: 300 } : payload;
    return { status: 200, ok: true, json: async () => json };
  };
}

test('F2 real artifact: the committed golden reaches the playhead through the real loader', async () => {
  serve(GOLDEN.payload);
  const result = await fetchPlayChords(GOLDEN.job_id);
  assert.equal(result.status, 'ready');

  const runs = observationsToRuns(result.observations);
  assert.equal(runs.length, GOLDEN.payload.segments.length, 'a segment was dropped');
  assert.ok(runsAreMonotone(runs));
  // The slash chord survives as a label with no flat-60 class index, and still
  // gets a marker — the case that used to be dropped for lacking an index.
  const slash = runs.find((r) => r.label === 'G:7/5');
  assert.ok(slash, 'the golden slash chord did not survive the loader');
  assert.equal(slash.chordClass, null);
  const idx = runs.indexOf(slash);
  assert.equal(activeRunIndex(runs, (slash.startSec + slash.endSec) / 2), idx);
  assert.ok(playheadGeometry(runs, idx, PX_PER_SEC));
  // Half-open boundaries hold on the golden's real times, not just on a grid.
  assert.equal(activeRunIndex(runs, 1.6), 1, 'boundary 1.6 must resolve to the LATER chord');
  assert.equal(activeRunIndex(runs, 4.8), -1, 'the end of the last chord sounds nothing');
});

test('F2 real artifact: a worker artifact whose segments arrive out of order is still playable', async () => {
  // The exact failure mode the contract does not forbid: the same golden
  // segments, shuffled on the wire. Before the fix this produced unsorted runs
  // and a hint that could change the answer.
  const shuffled = {
    ...GOLDEN.payload,
    segments: [GOLDEN.payload.segments[2], GOLDEN.payload.segments[0], GOLDEN.payload.segments[1]],
  };
  serve(shuffled);
  const result = await fetchPlayChords(GOLDEN.job_id);
  const runs = observationsToRuns(result.observations);
  assert.ok(runsAreMonotone(runs), 'runs from a shuffled artifact are not monotone');
  assert.deepEqual(
    runs.map((r) => r.label),
    GOLDEN.payload.segments.map((s) => s.label),
    'wire order was not repaired back to time order',
  );
});

// ---------------------------------------------------------------------------
// Fixture B — 159 segments, boundaries NOT on the 0.1 s grid
// ---------------------------------------------------------------------------

const TRACK_SEC = 151.29;
const N_SEGMENTS = 159;
const LABELS = ['E:min', 'A:maj', 'A:min', 'C:maj', 'G:maj', 'D:maj', 'B:min', 'F:maj', 'C', 'A'];
const PHI = (Math.sqrt(5) - 1) / 2; // irrational: successive multiples never repeat a phase

/**
 * Boundaries at `k * avg + jitter`, where the jitter is an irrational
 * multiple of the average. Every segment stays far longer than one 60 fps
 * frame (so a 60 fps sampler cannot skip one), while no boundary lands on a
 * frame edge, which is exactly what the 0.1 s grid guaranteed.
 */
function offGridObservations() {
  const avg = TRACK_SEC / N_SEGMENTS;
  const bounds = [0];
  for (let i = 1; i < N_SEGMENTS; i++) {
    bounds.push(i * avg + (((i * PHI) % 1) - 0.5) * avg * 0.6);
  }
  bounds.push(TRACK_SEC);
  return Array.from({ length: N_SEGMENTS }, (_, i) => ({
    startSec: bounds[i],
    endSec: bounds[i + 1],
    label: LABELS[i % LABELS.length],
    confidence: 1,
  }));
}

const OFF_GRID = observationsToRuns(offGridObservations());

test('F2 fixture: the off-grid fixture is non-degenerate where the 0.1 s grid was', () => {
  assert.equal(OFF_GRID.length, N_SEGMENTS);
  assert.ok(runsAreMonotone(OFF_GRID));
  const boundaries = OFF_GRID.slice(1).map((r) => r.startSec);
  // The grid fixture: every boundary * 60 is an integer, so ONE distinct phase.
  const phases = new Set(boundaries.map((b) => ((b * 60) % 1).toFixed(3)));
  assert.ok(phases.size > 100, `only ${phases.size} distinct frame phases; fixture is degenerate`);
  assert.equal(
    boundaries.filter((b) => Math.abs(b * 60 - Math.round(b * 60)) < 1e-9).length,
    0,
    'a boundary landed exactly on a frame edge',
  );
  // Nothing shorter than a frame, so a 60 fps walk cannot legitimately skip one.
  for (let i = 0; i < OFF_GRID.length; i++) {
    assert.ok(OFF_GRID[i].endSec - OFF_GRID[i].startSec > 1 / 60, `segment ${i} is sub-frame`);
  }
});

test('F2 fixture: a 60 fps sweep over off-grid boundaries still enters every chord once, in order', () => {
  const seen = [];
  let hint = -1;
  for (let f = 0; f / 60 < TRACK_SEC; f++) {
    const i = activeRunIndex(OFF_GRID, f / 60, hint);
    if (i !== -1 && i !== seen[seen.length - 1]) seen.push(i);
    if (i !== -1) hint = i;
  }
  assert.deepEqual(seen, OFF_GRID.map((_, i) => i));
});

// ---------------------------------------------------------------------------
// F2 — observationsToRuns now PRODUCES the invariant it used to assume
// ---------------------------------------------------------------------------

const obs = (label, startSec, endSec) => ({ label, startSec, endSec, confidence: 1 });

test('F2 repair: out-of-order observations come back sorted, and nothing is dropped', () => {
  const runs = observationsToRuns([
    obs('G:maj', 4, 5),
    obs('C:maj', 0, 1),
    obs('N', 2, 3),
    obs('A:min', 1, 2),
  ]);
  assert.equal(runs.length, 4, 'a run was dropped');
  assert.deepEqual(runs.map((r) => r.label), ['C:maj', 'A:min', 'N', 'G:maj']);
  assert.ok(runsAreMonotone(runs));
});

test('F2 repair: an overlap is resolved by trimming the EARLIER run, keeping both starts', () => {
  // The worker-side policy in _parse_klangio_response, applied here too, so a
  // repair on the web can never disagree with one in the worker.
  const runs = observationsToRuns([obs('C:maj', 1.9, 2.9), obs('G:maj', 2.6, 3.1)]);
  assert.deepEqual(
    runs.map((r) => [r.startSec, r.endSec]),
    [[1.9, 2.6], [2.6, 3.1]],
    'the earlier run was not trimmed to the later run start',
  );
  assert.ok(runsAreMonotone(runs));
  // Frames are re-derived from the trimmed seconds: a chord-edit payload built
  // from this run must not claim frames the run no longer covers.
  assert.equal(runs[0].endFrame, 26);
  assert.ok(runFramesAreMonotone(runs), 'trimmed run still overlaps in frames');
});

test('F2 repair: a run entirely swallowed by its predecessor becomes zero-length, not dropped', () => {
  const runs = observationsToRuns([obs('C:maj', 0, 10), obs('G:maj', 2, 3), obs('A:min', 2, 4)]);
  assert.equal(runs.length, 3, 'a swallowed run was dropped');
  assert.ok(runsAreMonotone(runs));
  // C:maj 0-10 is trimmed to 0-2; G:maj 2-3 keeps 2-3; A:min 2-4 starts at the
  // same instant as its predecessor, so it collapses to zero length.
  assert.deepEqual(runs.map((r) => [r.startSec, r.endSec]), [[0, 2], [2, 2], [2, 4]]);
  // A zero-length run still renders as a chip; it can never be the sounding
  // chord, whatever hint points at it.
  const zeroIdx = runs.findIndex((r) => r.endSec === r.startSec);
  assert.ok(zeroIdx >= 0, 'nothing collapsed');
  // THE FALSE GREEN this test used to coexist with. It asserted seconds only,
  // so a run repaired to zero SECONDS could still claim one FRAME — and that
  // frame sat inside its successor's span. On exactly this fixture the old code
  // gave G sec=[2,2] frames=[20,21] inside A frames=[20,40].
  assert.equal(runs[zeroIdx].endFrame, runs[zeroIdx].startFrame, 'zero seconds must mean zero frames');
  assert.ok(runFramesAreMonotone(runs), 'a zero-length run claims a frame its successor owns');
  assert.deepEqual(runs.map((r) => [r.startFrame, r.endFrame]), [[0, 20], [20, 20], [20, 40]]);
  for (const h of HINTS) {
    assert.notEqual(activeRunIndex(runs, runs[zeroIdx].startSec, h), zeroIdx);
    assert.equal(activeRunIndex(runs, 2, h), 2, `hint ${String(h)} changed the answer at t=2`);
  }
});

test('F2 repair: frame spans carry the same invariant as the seconds, sub-frame runs included', () => {
  // The `startFrame + 1` floor broke this for ANY run shorter than half a
  // frame, not just zero-length ones: [2.0, 2.02] rounded to frames [20, 20]
  // but was floored to [20, 21], overlapping a successor starting at frame 20.
  const runs = observationsToRuns([
    obs('C:maj', 2.0, 2.02),
    obs('G:maj', 2.02, 3),
    obs('A:min', 3, 3.001),
    obs('F:maj', 3.001, 4),
  ]);
  assert.ok(runsAreMonotone(runs));
  assert.ok(runFramesAreMonotone(runs), 'a sub-frame run claims a frame its successor owns');
  assert.deepEqual(runs.map((r) => [r.startFrame, r.endFrame]), [[20, 20], [20, 30], [30, 30], [30, 40]]);
  // And on both real fixtures, where every run is comfortably multi-frame.
  assert.ok(runFramesAreMonotone(OFF_GRID));
});

test('F2 repair: a negative or non-finite start is clamped, never propagated', () => {
  const runs = observationsToRuns([obs('C:maj', -3, 1), obs('G:maj', 1, 2)]);
  assert.equal(runs[0].startSec, 0);
  assert.equal(runs[0].startFrame, 0);
  assert.ok(runsAreMonotone(runs));
  const backwards = observationsToRuns([obs('C:maj', 5, 2)]);
  assert.equal(backwards[0].endSec, 5, 'a backwards span must collapse, not go negative');
  assert.ok(runsAreMonotone(backwards));
});

test('F2 repair: a non-finite END is clamped too, not just a non-finite start', () => {
  // Mutation survivor the reviewer of this PR found: dropping the
  // `Number.isFinite(o.endSec)` guard changed 92,356 / 200,000 fuzz datasets
  // and NO test noticed, because the NaN test below only varies startSec.
  // Unreachable through the loader (it rejects non-finite times) — this is
  // defensive code, and defensive code with no test is just a comment.
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '3']) {
    const runs = observationsToRuns([
      obs('C:maj', 1, bad),
      obs('G:maj', 2, 3),
    ]);
    assert.equal(runs.length, 2, `a run was dropped for endSec=${String(bad)}`);
    assert.ok(runsAreMonotone(runs), `endSec=${String(bad)} broke the seconds invariant`);
    assert.ok(runFramesAreMonotone(runs), `endSec=${String(bad)} broke the frame invariant`);
    for (const r of runs) {
      assert.ok(Number.isFinite(r.startSec) && Number.isFinite(r.endSec), String(bad));
      assert.ok(Number.isInteger(r.startFrame) && Number.isInteger(r.endFrame), String(bad));
    }
  }
});

test('F2 repair: a NaN start cannot break the ordering the sort cannot establish', () => {
  // The one case the sort alone does not fix: every comparison against NaN is
  // false, so a NaN-start row can land anywhere in the sorted array. The
  // running floor is what still makes the output monotone. The loader rejects
  // non-finite times today, so this is defence against the next producer, not
  // a live bug — but it is the line that has to hold for the mark to be true.
  for (const nanLike of [NaN, Infinity, -Infinity]) {
    const runs = observationsToRuns([
      obs('C:maj', 0, 1),
      obs('G:maj', nanLike, 2.5),
      obs('A:min', 2, 3),
    ]);
    assert.equal(runs.length, 3, `a run was dropped for ${String(nanLike)}`);
    assert.ok(runsAreMonotone(runs), `a ${String(nanLike)} start broke the invariant`);
    for (const r of runs) assert.ok(Number.isFinite(r.startSec) && Number.isFinite(r.endSec));
  }
});

test('F2 repair: observationsToRuns marks its output; a derived array does not carry the mark', () => {
  const runs = observationsToRuns([obs('C:maj', 0, 1)]);
  assert.ok(hasMonotoneRunsMark(runs), 'observationsToRuns must mark its output');
  assert.ok(!hasMonotoneRunsMark(runs.slice()), 'a .slice() must not inherit the promise');
  assert.ok(!hasMonotoneRunsMark([{ startSec: 0, endSec: 1 }]), 'a hand-built array must be unmarked');
  assert.ok(hasMonotoneRunsMark(markMonotoneRuns([{ startSec: 0, endSec: 1 }])));
  // A frozen array cannot carry the mark, and that must not throw on a render.
  const frozen = Object.freeze([{ startSec: 0, endSec: 1 }]);
  assert.ok(!hasMonotoneRunsMark(markMonotoneRuns(frozen)));
  assert.equal(activeRunIndex(frozen, 0.5, 0), 0, 'an unmarkable array still answers correctly');
});

test('F2 mark: a polluted Array.prototype cannot forge the monotone promise', () => {
  // The mark gate is the single read the whole correctness argument rests on.
  // A plain `runs[SYM]` read goes through the prototype chain, so ONE
  // Object.defineProperty on Array.prototype would mark every array in the
  // page and put every run list back on the hint fast path.
  const SYM = Symbol.for('stem-loops.chord.monotoneRuns');
  const overlapping = [{ startSec: 0, endSec: 10 }, { startSec: 2, endSec: 3 }];
  assert.ok(!hasMonotoneRunsMark(overlapping), 'unmarked to begin with');
  Object.defineProperty(Array.prototype, SYM, { value: true, configurable: true });
  try {
    assert.ok(!hasMonotoneRunsMark([]), 'prototype pollution forged the mark');
    assert.ok(!hasMonotoneRunsMark(overlapping), 'prototype pollution forged the mark');
    // And the hint stays inert on that array, which is what actually matters.
    for (const h of HINTS) {
      assert.equal(activeRunIndex(overlapping, 2.5, h), activeRunIndex(overlapping, 2.5));
    }
    // A genuinely marked array still works — the gate is not just always-false.
    assert.ok(hasMonotoneRunsMark(observationsToRuns([obs('C:maj', 0, 1)])));
  } finally {
    delete Array.prototype[SYM];
  }
  assert.ok(!hasMonotoneRunsMark([]), 'cleanup failed');
});

// ---------------------------------------------------------------------------
// F2 — the hint is a pure accelerator, now for ANY input
// ---------------------------------------------------------------------------

/** Every hint value a caller, a stale frame or a hostile caller could pass. */
const HINTS = [
  undefined, null, -1, 0, 1, 2, 3, 4, 5, 7, 11, 158, 159, 1000, -5, 2.5, 0.5,
  NaN, Infinity, -Infinity, '3', true, {},
];

test('F2 hint purity: the reviewer’s reproduction case no longer diverges', () => {
  // Verbatim from the review: runs [..., [1.9, 2.9], [2.6, 3.1], ...] at
  // t = 2.6 with hint = 3 returned 4 with the hint and 5 without it.
  const raw = [
    { startSec: 0.0, endSec: 0.7 },
    { startSec: 0.7, endSec: 1.2 },
    { startSec: 1.2, endSec: 1.5 },
    { startSec: 1.5, endSec: 1.9 },
    { startSec: 1.9, endSec: 2.9 },
    { startSec: 2.6, endSec: 3.1 },
    { startSec: 3.1, endSec: 3.8 },
  ];
  // (a) Raw and unmarked: the hint is refused outright, so it cannot matter.
  for (const h of HINTS) assert.equal(activeRunIndex(raw, 2.6, h), activeRunIndex(raw, 2.6));
  // (b) Through the repair, the overlap is gone and index 5 is unambiguous.
  const runs = observationsToRuns(raw.map((r, i) => obs(i % 2 ? 'C:maj' : 'G:maj', r.startSec, r.endSec)));
  assert.ok(runsAreMonotone(runs));
  assert.equal(activeRunIndex(runs, 2.6), 5);
  for (const h of HINTS) assert.equal(activeRunIndex(runs, 2.6, h), 5, `hint ${String(h)} changed the answer`);
});

test('F2 hint purity: fuzz over hostile datasets — overlapping, unsorted, gapped, zero-length', () => {
  // The in-repo guard. The full sweep lives in the PR body (20,000 datasets per
  // mode); this is sized to stay cheap in CI while still covering thousands of
  // datasets across all four shapes, and the divergence count must be 0.
  const DATASETS = 2500;
  let s = 0xc0ffee >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  let diverged = 0;
  let overlapping = 0;
  let unsorted = 0;
  let comparisons = 0;
  let firstExample = null;

  for (let d = 0; d < DATASETS; d++) {
    // Build observations that break every assumption at once.
    const n = 2 + Math.floor(rnd() * 10);
    const raw = [];
    let cursor = rnd() < 0.2 ? -0.5 : 0;
    for (let i = 0; i < n; i++) {
      let start = cursor;
      if (rnd() < 0.3) start += rnd() * 1.5; // gap
      if (rnd() < 0.5) start -= rnd() * 1.2; // overlap
      const end = start + (rnd() < 0.12 ? 0 : rnd() * 2); // sometimes zero-length
      raw.push(obs(i % 3 === 0 ? 'C:maj' : i % 3 === 1 ? 'N' : 'A:min', start, end));
      cursor = end;
    }
    for (let i = raw.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [raw[i], raw[j]] = [raw[j], raw[i]];
    }

    // Three shapes: the repaired pipeline, and the raw array sorted and
    // unsorted. Deliberately NOT a hand-marked liar — a forged mark puts the
    // hint back in play by design, so it would fail the `diverged === 0`
    // assertion below. That case is covered by its own tests instead (the
    // lying-mark test above and the prototype-pollution test).
    const sorted = raw.map((o) => ({ startSec: o.startSec, endSec: o.endSec }))
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    const shapes = [
      observationsToRuns(raw),
      sorted,
      raw.map((o) => ({ startSec: o.startSec, endSec: o.endSec })),
    ];

    for (const runs of shapes) {
      if (runs.length === 0) continue;
      if (runs === shapes[0]) {
        // Only the repaired shape makes any promise; the raw ones are hostile
        // by construction and are here to prove the hint stays inert.
        assert.ok(runsAreMonotone(runs), `dataset ${d}: repaired seconds not monotone`);
        assert.ok(runFramesAreMonotone(runs), `dataset ${d}: repaired frames not monotone`);
      }
      for (let i = 1; i < runs.length; i++) {
        if (runs[i].startSec < runs[i - 1].startSec) unsorted++;
        if (runs[i].startSec < runs[i - 1].endSec) overlapping++;
      }
      const ts = new Set([0, 0.25, 1e-12]);
      for (const r of runs) {
        for (const v of [r.startSec, r.endSec, (r.startSec + r.endSec) / 2]) {
          ts.add(v);
          ts.add(v + 1e-9);
          ts.add(v - 1e-9);
        }
      }
      for (const t of ts) {
        if (!Number.isFinite(t)) continue;
        const truth = activeRunIndex(runs, t);
        for (const h of HINTS) {
          comparisons++;
          const got = activeRunIndex(runs, t, h);
          if (got !== truth) {
            diverged++;
            firstExample ??= { runs: runs.map((r) => [r.startSec, r.endSec]), t, hint: String(h), got, truth };
          }
        }
      }
    }
  }

  // The fuzz must actually have produced the hostile shapes it claims to test.
  assert.ok(overlapping > 1000, `fuzz produced only ${overlapping} overlaps; it is not testing the defect`);
  assert.ok(unsorted > 1000, `fuzz produced only ${unsorted} unsorted pairs; it is not testing the defect`);
  assert.ok(comparisons > 1_000_000, `only ${comparisons} comparisons`);
  assert.equal(diverged, 0, `hint changed the answer ${diverged} times, e.g. ${JSON.stringify(firstExample)}`);
});

test('F2 hint purity: a marked array that is NOT monotone is a caller bug, and runsAreMonotone catches it', () => {
  // The mark is a promise, not a check — so there must be a way to audit it.
  const lying = markMonotoneRuns([
    { startSec: 0, endSec: 10 },
    { startSec: 2, endSec: 3 },
  ]);
  assert.ok(hasMonotoneRunsMark(lying));
  assert.ok(!runsAreMonotone(lying), 'runsAreMonotone must reject an overlapping array');
  assert.ok(!runsAreMonotone([{ startSec: 1, endSec: 2 }, { startSec: 0, endSec: 1 }]));
  assert.ok(!runsAreMonotone([{ startSec: 0, endSec: NaN }]));
  assert.ok(runsAreMonotone([]));
  assert.ok(runsAreMonotone([{ startSec: 0, endSec: 1 }, { startSec: 1, endSec: 2 }]));
});

test('F2 auditors: both auditors can actually FAIL \u2014 an auditor that cannot is a false green', () => {
  // Found as a mutation survivor on this round: making runFramesAreMonotone
  // return true unconditionally broke nothing, even though several tests and
  // the fuzz lean on it. An assertion helper with no negative test is exactly
  // the defect class this PR exists to close, so it gets the same treatment.
  const fr = (startFrame, endFrame) => ({ startFrame, endFrame });
  assert.ok(runFramesAreMonotone([]), 'empty is vacuously fine');
  assert.ok(runFramesAreMonotone([fr(0, 10), fr(10, 20), fr(20, 20), fr(20, 30)]));
  // Each way it must say no, one at a time.
  assert.ok(!runFramesAreMonotone([fr(0, 10), fr(5, 20)]), 'overlapping frames accepted');
  assert.ok(!runFramesAreMonotone([fr(10, 5)]), 'reversed frame span accepted');
  assert.ok(!runFramesAreMonotone([fr(0, 10), fr(20, 30), fr(15, 40)]), 'unsorted frames accepted');
  assert.ok(!runFramesAreMonotone([fr(0, 1.5)]), 'non-integer frame accepted');
  assert.ok(!runFramesAreMonotone([fr(NaN, 1)]), 'NaN frame accepted');
  // And the seconds auditor, symmetrically.
  const sc = (startSec, endSec) => ({ startSec, endSec });
  assert.ok(!runsAreMonotone([sc(0, 10), sc(5, 20)]), 'overlapping seconds accepted');
  assert.ok(!runsAreMonotone([sc(10, 5)]), 'reversed second span accepted');
  assert.ok(!runsAreMonotone([sc(0, 1), sc(5, 6), sc(2, 3)]), 'unsorted seconds accepted');
  assert.ok(!runsAreMonotone([sc(0, Infinity)]), 'infinite second accepted');
});

test('F2 live path: collapseRuns really is monotone, and the component marks it', () => {
  // Mutation survivor the reviewer found: nothing checked that the live
  // tab-capture path marks its runs, NOR that the promise hand-written there
  // is true. The mark is an assertion, so the thing it asserts needs a test.
  for (const [classes, frameSec] of [
    [[0, 0, 1, 1, 1, 2, 0], 0.1],
    [[5], 0.1],
    [[], 0.1],
    [[3, 3, 3, 3], 1 / 30],
    [Array.from({ length: 200 }, (_, i) => i % 7), 0.1],
  ]) {
    const collapsed = collapseRuns(classes, frameSec);
    assert.ok(runsAreMonotone(collapsed), `collapseRuns(${classes.length} frames) is not monotone`);
    assert.ok(runFramesAreMonotone(collapsed), `collapseRuns(${classes.length} frames) frames overlap`);
  }
  // Contiguity is the stronger property the component's comment relies on.
  const c = collapseRuns([0, 0, 1, 2, 2, 2], 0.1);
  for (let i = 1; i < c.length; i++) assert.equal(c[i].startSec, c[i - 1].endSec);
  // And the component re-asserts the mark after the `.map` that drops it.
  assert.match(
    OVERLAY_TSX,
    /const runs: OverlayRun\[\] = markMonotoneRuns\(\s*\n\s*collapseRuns\(classes, frameSec\)\.map\(/,
    'the live path no longer marks its runs, so every frame pays a binary search',
  );
});

// ---------------------------------------------------------------------------
// F1 — a frame must cost the marker, which means nothing O(n) outside a memo
// ---------------------------------------------------------------------------

/**
 * Every call to `name` inside ChordOverlay.tsx, with whether it is lexically
 * inside a `useMemo(...)` / `useCallback(...)` / `useEffect(...)` call. A call
 * outside all three runs on EVERY render, which is every animation frame while
 * playing.
 */
function callSites(name) {
  const sf = ts.createSourceFile('ChordOverlay.tsx', OVERLAY_TSX, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const sites = [];
  const HOOKS = new Set(['useMemo', 'useCallback', 'useEffect']);
  const walk = (node, inHook) => {
    let nowInHook = inHook;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (callee === name) {
        sites.push({ inHook, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      }
      if (HOOKS.has(callee)) nowInHook = true;
    }
    node.forEachChild((c) => walk(c, nowInHook));
  };
  walk(sf, false);
  return sites;
}

test('F1 per-frame cost: every O(n) helper in ChordOverlay is called inside a memo, not per render', () => {
  // #187's comment claimed "a frame costs the marker and nothing else". It was
  // true of the chips and false of these three: durationSec and timelineWidthPx
  // each walk every run, and rulerTicks rebuilds (and re-allocates) every tick.
  for (const name of ['durationSec', 'timelineWidthPx', 'rulerTicks']) {
    const sites = callSites(name);
    assert.ok(sites.length > 0, `${name} is no longer called from ChordOverlay.tsx — update this test`);
    for (const site of sites) {
      assert.ok(site.inHook, `${name}() at ChordOverlay.tsx:${site.line} runs on every render, so every frame`);
    }
  }
});

test('F1 per-frame cost: the memoised helpers are genuinely O(n), so memoising them is the fix', () => {
  // Not an adjective: count the element reads each helper makes over the runs,
  // which is the work a frame used to repeat. Deterministic, so it can assert.
  const counting = (arr) => {
    const stats = { gets: 0 };
    return [
      new Proxy(arr, {
        get(t, p, r) {
          if (typeof p === 'string' && /^\d+$/.test(p)) stats.gets++;
          return Reflect.get(t, p, r);
        },
      }),
      stats,
    ];
  };
  const [p1, s1] = counting(OFF_GRID);
  durationSec(p1);
  assert.equal(s1.gets, OFF_GRID.length, 'durationSec is not O(n) any more — update this test');
  const [p2, s2] = counting(OFF_GRID);
  timelineWidthPx(p2, PX_PER_SEC);
  assert.equal(s2.gets, OFF_GRID.length, 'timelineWidthPx is not O(n) any more');
  // The ruler at the default fit-to-width zoom for this track.
  assert.ok(rulerTicks(TRACK_SEC, PX_PER_SEC).length > 10, 'the ruler is not worth memoising?');
});

test('F1 per-frame cost: the comment no longer claims more than the code does', () => {
  assert.doesNotMatch(
    OVERLAY_TSX,
    /a frame costs the marker and nothing else/,
    'the overstated per-frame claim is back',
  );
});

// ---------------------------------------------------------------------------
// F3 — a zoom must not read as a manual scroll
// ---------------------------------------------------------------------------
//
// BRITTLENESS, stated rather than discovered later: the F3 and F5 tests below
// match SOURCE LITERALS in ChordOverlay.tsx. That is the only lever available
// without jsdom, and it cuts both ways — a reformat (`prettier --write`) would
// redden them without any behaviour changing, and a behaviour-preserving
// rewrite that keeps the literals would keep them green. They are regression
// tripwires on the shape of the code, not tests of the component. The F1 AST
// test above is different in kind: it walks the TSX AST and fails on ANY
// uncached call site, so it checks a property rather than a spelling.

test('F3 zoom: recording the REQUESTED scrollLeft is what made a clamped zoom look manual', () => {
  // The mechanism, at the helper boundary. The scrollLeft setter clamps to
  // scrollWidth - clientWidth (CSSOM View), so zooming out while parked in the
  // last half-screen lands short of what we asked for.
  const scrollWidth = 4000;
  const clientWidth = 800;
  const maxScroll = scrollWidth - clientWidth; // 3200
  const requested = 3600; // asked for past the end
  const actual = Math.min(requested, maxScroll); // what the element takes
  assert.ok(
    isManualScroll(actual, requested),
    'recording the request would NOT have looked manual — the premise is wrong',
  );
  assert.ok(
    !isManualScroll(actual, actual),
    'recording what the element took must read as ours',
  );
});

test('F3 zoom: the effect records el.scrollLeft after assigning it, never the requested value', () => {
  const zoomEffect = OVERLAY_TSX.slice(
    OVERLAY_TSX.indexOf('After a zoom change keep the same moment centred'),
    OVERLAY_TSX.indexOf('chord playhead (Story 3)'),
  );
  assert.ok(zoomEffect.length > 100, 'could not locate the zoom effect — update this test');
  assert.doesNotMatch(
    zoomEffect,
    /lastAutoLeftRef\.current\s*=\s*next/,
    'the zoom effect records the requested scrollLeft again',
  );
  assert.match(zoomEffect, /el\.scrollLeft\s*=\s*next/);
  assert.match(zoomEffect, /lastAutoLeftRef\.current\s*=\s*el\.scrollLeft/);
  // Order matters: assign, then read back.
  assert.ok(
    zoomEffect.indexOf('el.scrollLeft = next') <
      zoomEffect.indexOf('lastAutoLeftRef.current = el.scrollLeft'),
    'the read-back must come AFTER the assignment',
  );
});

test('F3 zoom: nothing in the component records a scroll position it only asked for', () => {
  const assignments = OVERLAY_TSX.match(/lastAutoLeftRef\.current\s*=\s*[^;]+;/g) ?? [];
  assert.ok(assignments.length >= 2, 'expected the zoom and auto-scroll effects to both record');
  for (const a of assignments) {
    // syncScroll records the observed el.scrollLeft when it detects a manual
    // scroll; every other write must be a read-back of el.scrollLeft.
    assert.match(a, /el\.scrollLeft/, `records a value that is not el.scrollLeft: ${a.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// F5 — the "Now ..." row must not change height mid-playback
// ---------------------------------------------------------------------------

test('F5 layout: the Now row is mounted for all of playback, and only the chip toggles', () => {
  // It used to be mounted on `playhead && activeRun`, so crossing a gap
  // between chords unmounted a ~28px row and shoved everything below it.
  assert.match(
    OVERLAY_TSX,
    /\{isPlaying \? \(\s*<div style=\{playheadBarStyle\} data-testid="playhead-bar"/,
    'the Now row is no longer mounted for the whole of playback',
  );
  assert.doesNotMatch(
    OVERLAY_TSX,
    /\{playhead && activeRun \? \(\s*<div style=\{playheadBarStyle\}/,
    'the Now row is conditional on a chord sounding again',
  );
  // The chip hides rather than unmounting, so the row keeps its height.
  assert.match(
    OVERLAY_TSX,
    /visibility: playhead && activeRun \? 'visible' : 'hidden'/,
    'the Now chip must toggle visibility, not mount state',
  );
  // Criterion 6 still holds: not playing renders exactly as before.
  assert.match(
    OVERLAY_TSX,
    /const isPlaying =\s*\n?\s*typeof positionSec === 'number' && Number\.isFinite\(positionSec\) && positionSec >= 0;/,
    'isPlaying must be derived from positionSec alone',
  );
});
