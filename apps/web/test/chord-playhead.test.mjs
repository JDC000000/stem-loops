// Chord playhead — Story 3 of claude/user-stories-play-along-2026-11-10.md v2.0.
//
// The playhead is the clause of the product sentence that did not exist: "the
// chords go by as you play along". The chords already rendered; they did not
// move. These tests pin the three things that can silently ruin that:
//
//   1. WHICH chord is sounding. Wrong by one and the user plays the wrong
//      chord, which is worse than no playhead at all. Every segment, every
//      boundary, every gap and every hostile position is covered, and the
//      worst-case error is MEASURED, not asserted by adjective (Gate 4 /
//      TSD §12.3 — see the "sync tolerance" block).
//   2. That the marker STEPS chord to chord (Chordify) rather than sliding
//      smoothly through a chord — Jon chose that explicitly on 2026-11-10.
//   3. That auto-scroll follows playback but STOPS FIGHTING a user who has
//      scrolled by hand. "A view that yanks itself back is worse than one
//      that does not follow."
//
// Fixtures are built to the shape of a real production artifact, verified
// against a real job the same day: 159 segments, 10 distinct labels, real
// contiguous start/end times, on a 151.29 s track.
//
// The component itself is .tsx, which Node's --experimental-strip-types
// loader refuses, so these drive the pure helpers the component renders
// from — the same split the existing ChordOverlay tests use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLAYHEAD_LEAD_FRACTION,
  PLAYHEAD_MARGIN_PX,
  PX_PER_SEC,
  SCROLL_MATCH_TOLERANCE_PX,
  activeRunIndex,
  chipBox,
  displayText,
  isManualScroll,
  observationsToRuns,
  playheadGeometry,
  resolveAutoScroll,
} from '../src/components/ChordOverlay.helpers.ts';

import { codeOnly } from './helpers/code-only.mjs';

// ---------------------------------------------------------------------------
// Fixtures — the real artifact's shape
// ---------------------------------------------------------------------------

const TRACK_SEC = 151.29;
const N_SEGMENTS = 159;
// 10 distinct labels, the Em -> A -> Am -> C progression the real job carries,
// in the Harte spelling ChordObservation documents, plus the bare-root forms
// the worker also emits.
const LABELS = ['E:min', 'A:maj', 'A:min', 'C:maj', 'G:maj', 'D:maj', 'B:min', 'F:maj', 'C', 'A'];

/** Deterministic LCG so every run sees identical fixtures. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * 159 contiguous observations ending exactly at 151.29 s, with varied
 * durations quantised to the worker's 0.1 s frame grid. Contiguous means
 * `obs[i].endSec === obs[i + 1].startSec` EXACTLY, which is what makes the
 * half-open boundary tests below meaningful.
 */
function realShapeObservations() {
  const rnd = lcg(20261110);
  const weights = Array.from({ length: N_SEGMENTS }, () => 0.5 + rnd());
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds = [0];
  let acc = 0;
  for (let i = 0; i < N_SEGMENTS - 1; i++) {
    acc += weights[i];
    // Quantise to the 0.1 s grid, but never let a segment collapse to zero.
    const t = Math.round((acc / total) * TRACK_SEC * 10) / 10;
    bounds.push(Math.max(bounds[i] + 0.1, Math.min(t, TRACK_SEC - (N_SEGMENTS - 1 - i) * 0.1)));
  }
  bounds.push(TRACK_SEC);
  return Array.from({ length: N_SEGMENTS }, (_, i) => ({
    startSec: bounds[i],
    endSec: bounds[i + 1],
    label: LABELS[i % LABELS.length],
    confidence: 1,
  }));
}

const OBS = realShapeObservations();
const RUNS = observationsToRuns(OBS);
/** The 158 internal chord changes. */
const BOUNDARIES = RUNS.slice(1).map((r) => r.startSec);

test('fixture is faithful to the production artifact: 159 contiguous segments, 10 labels, 151.29 s', () => {
  assert.equal(RUNS.length, 159);
  assert.equal(new Set(RUNS.map((r) => r.label)).size, 10);
  assert.equal(RUNS[0].startSec, 0);
  assert.equal(RUNS[RUNS.length - 1].endSec, TRACK_SEC);
  for (let i = 1; i < RUNS.length; i++) {
    assert.equal(RUNS[i].startSec, RUNS[i - 1].endSec, `gap/overlap at ${i}`);
    assert.ok(RUNS[i].endSec > RUNS[i].startSec, `zero-length run at ${i}`);
  }
  // Labels survive into display, including the bare-root forms.
  assert.equal(displayText(RUNS[8]), 'C');
});

// ---------------------------------------------------------------------------
// 1. Which chord is sounding
// ---------------------------------------------------------------------------

test('active segment: every one of the 159 segments is reported for a position inside it', () => {
  RUNS.forEach((r, i) => {
    const mid = r.startSec + (r.endSec - r.startSec) / 2;
    assert.equal(activeRunIndex(RUNS, mid), i, `midpoint of ${i}`);
    // Just inside each edge, too.
    assert.equal(activeRunIndex(RUNS, r.startSec), i, `start of ${i}`);
  });
});

test('active segment: exactly ON a boundary resolves to the LATER chord (half-open [start, end))', () => {
  // The convention is inherited, not invented: ChordObservation documents
  // startSec as inclusive and endSec as exclusive. At t === endSec(i) ===
  // startSec(i+1) the chord you hear is i+1, so that is what is reported.
  assert.equal(BOUNDARIES.length, 158);
  BOUNDARIES.forEach((b, k) => {
    assert.equal(activeRunIndex(RUNS, b), k + 1, `boundary ${k} at ${b}s`);
  });
});

test('active segment: before the first chord, and in a gap, nothing is sounding', () => {
  // A leading gap: the track starts with 2 s of no observation at all.
  const gapped = observationsToRuns([
    { startSec: 2, endSec: 4, label: 'E:min', confidence: 1 },
    { startSec: 4, endSec: 6, label: 'A:maj', confidence: 1 },
    // 6 -> 9 is a hole Klangio can leave.
    { startSec: 9, endSec: 11, label: 'A:min', confidence: 1 },
  ]);
  assert.equal(activeRunIndex(gapped, 0), -1, 'before the first chord');
  assert.equal(activeRunIndex(gapped, 1.999), -1);
  assert.equal(activeRunIndex(gapped, 2), 0, 'first chord starts');
  assert.equal(activeRunIndex(gapped, 5), 1);
  assert.equal(activeRunIndex(gapped, 6), -1, 'in the gap');
  assert.equal(activeRunIndex(gapped, 7.5), -1, 'in the gap');
  assert.equal(activeRunIndex(gapped, 8.999), -1, 'in the gap');
  assert.equal(activeRunIndex(gapped, 9), 2, 'out the far side of the gap');
  assert.equal(activeRunIndex(gapped, 11), -1, 'exactly at the end');
});

test('active segment: at and beyond the end of the track, nothing is sounding', () => {
  assert.equal(activeRunIndex(RUNS, TRACK_SEC), -1, 'exactly at the end');
  assert.equal(activeRunIndex(RUNS, TRACK_SEC + 0.001), -1);
  assert.equal(activeRunIndex(RUNS, 200), -1, 'beyond the track');
  assert.equal(activeRunIndex(RUNS, 1e9), -1);
});

test('active segment: null means "not playing" and every hostile position is -1, never a throw', () => {
  const hostile = [
    null, undefined, NaN, Infinity, -Infinity,
    -0.001, -1, -1e9,
    '5', '', {}, [], true, false, 0n === 0n ? 'x' : 'y',
  ];
  for (const p of hostile) {
    let got;
    assert.doesNotThrow(() => { got = activeRunIndex(RUNS, p); }, String(p));
    assert.equal(got, -1, `position ${String(p)}`);
  }
  // -0 is a legitimate 0 and must behave like the start of the track.
  assert.equal(activeRunIndex(RUNS, -0), 0);
});

test('active segment: empty and degenerate run lists are safe', () => {
  assert.equal(activeRunIndex([], 5), -1);
  assert.equal(activeRunIndex([], null), -1);
  // A zero-length run covers no instant at all.
  const zero = [{ startSec: 3, endSec: 3 }];
  assert.equal(activeRunIndex(zero, 3), -1);
  assert.equal(activeRunIndex(zero, 2.999), -1);
});

test('active segment: the hint is a pure accelerator — it can never change the answer', () => {
  // This is the invariant that makes the O(1) fast path safe. If anyone makes
  // the hint load-bearing, this fails loudly.
  const hints = [undefined, null, -1, 0, 1, 7, 80, 158, 159, 1000, -5, 2.5, NaN, Infinity, '3'];
  let checked = 0;
  for (let t = 0; t <= TRACK_SEC + 1; t += 0.037) {
    const truth = activeRunIndex(RUNS, t);
    for (const h of hints) {
      assert.equal(activeRunIndex(RUNS, t, h), truth, `t=${t} hint=${String(h)}`);
    }
    checked++;
  }
  // And on every boundary, where an off-by-one hint is most tempting.
  for (const b of BOUNDARIES) {
    const truth = activeRunIndex(RUNS, b);
    for (const h of hints) assert.equal(activeRunIndex(RUNS, b, h), truth, `boundary ${b} hint=${String(h)}`);
  }
  assert.ok(checked > 4000, `swept ${checked} positions`);
});

test('active segment: a forward position series steps monotonically through every chord, once each', () => {
  // What "the chords go by" actually means: play the whole track at 60 fps and
  // the reported chord must walk 0,1,2,...,158 with no skips and no going back.
  const seen = [];
  let hint = -1;
  for (let f = 0; f * (1 / 60) < TRACK_SEC; f++) {
    const idx = activeRunIndex(RUNS, f / 60, hint);
    if (idx !== -1 && idx !== seen[seen.length - 1]) seen.push(idx);
    if (idx !== -1) hint = idx;
  }
  assert.deepEqual(seen, RUNS.map((_, i) => i), 'every chord entered exactly once, in order');
});

// ---------------------------------------------------------------------------
// MEASURED SYNC TOLERANCE — Gate 4 / TSD §12.3
// ---------------------------------------------------------------------------

/** Largest double strictly below x (x > 0). */
function prevFloat(x) {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  const hi = v.getUint32(0);
  const lo = v.getUint32(4);
  if (lo === 0) {
    v.setUint32(0, hi - 1);
    v.setUint32(4, 0xffffffff);
  } else {
    v.setUint32(4, lo - 1);
  }
  return v.getFloat64(0);
}

test('sync tolerance: the LOOKUP itself contributes 0 ms of error, to the last representable bit', () => {
  // At every one of the 158 boundaries, the lookup separates the two adjacent
  // doubles: prevFloat(b) is still the old chord, b is already the new one.
  // There is no interval of time in which it reports the wrong chord, so the
  // lookup's own error is 0 ms by construction, not by tolerance.
  for (let k = 0; k < BOUNDARIES.length; k++) {
    const b = BOUNDARIES[k];
    assert.equal(activeRunIndex(RUNS, prevFloat(b)), k, `just before boundary ${k}`);
    assert.equal(activeRunIndex(RUNS, b), k + 1, `at boundary ${k}`);
    assert.ok(b - prevFloat(b) < 1e-12, 'adjacent doubles');
  }
});

test('sync tolerance: end-to-end error is bounded by ONE position sample, measured in ms', () => {
  // The only error left is sampling: positionSec arrives once per animation
  // frame, so a chord change is seen at the first frame at or after it. The
  // worst case is therefore one frame interval, and we measure it rather than
  // claim it.
  // The frame clock is NOT in phase with the chord boundaries in general, so
  // the phase is swept: the worker's 0.1 s label grid happens to be an exact
  // multiple of 1/60 s, which would otherwise flatter the measurement to 0.
  const report = {};
  for (const hz of [60, 30]) {
    const frameMs = 1000 / hz;
    let worstMs = 0;
    for (let p = 0; p < 97; p++) {
      const phase = (p / 97) * (1 / hz); // sub-frame offset of the clock
      let hint = -1;
      let prevIdx = activeRunIndex(RUNS, phase, hint);
      for (let f = 1; f / hz + phase < TRACK_SEC; f++) {
        const t = f / hz + phase;
        const idx = activeRunIndex(RUNS, t, hint);
        if (idx !== -1) hint = idx;
        if (idx !== prevIdx && idx > 0) {
          // The true boundary is this chord's startSec; we noticed it at t.
          const errMs = (t - RUNS[idx].startSec) * 1000;
          assert.ok(errMs >= 0, 'a chord must never be reported before it starts');
          if (errMs > worstMs) worstMs = errMs;
        }
        prevIdx = idx;
      }
    }
    assert.ok(
      worstMs < frameMs + 1e-9,
      `${hz}Hz: worst ${worstMs.toFixed(3)}ms must be < one frame (${frameMs.toFixed(3)}ms)`,
    );
    // The sweep must actually have found a near-worst case, or the bound is
    // untested rather than met.
    assert.ok(worstMs > frameMs * 0.9, `${hz}Hz: phase sweep only reached ${worstMs.toFixed(3)}ms`);
    report[`${hz}Hz`] = worstMs;
  }
  // Printed so the number in the PR is the number the suite produced.
  console.log(
    `    MEASURED sync tolerance: lookup 0.000 ms; ` +
    `60Hz worst ${report['60Hz'].toFixed(3)} ms (bound 16.667); ` +
    `30Hz worst ${report['30Hz'].toFixed(3)} ms (bound 33.333)`,
  );
  assert.ok(report['60Hz'] <= 16.667);
});

// ---------------------------------------------------------------------------
// Complexity: the lookup must be better than O(n) per frame
// ---------------------------------------------------------------------------

/** Wraps runs so every ELEMENT access is counted. A linear scan cannot hide. */
function counting(runs) {
  const stats = { gets: 0 };
  const proxy = new Proxy(runs, {
    get(target, prop, recv) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) stats.gets++;
      return Reflect.get(target, prop, recv);
    },
  });
  return { proxy, stats };
}

test('complexity: a correct hint costs O(1) element reads; a cold lookup costs O(log n), never O(n)', () => {
  const COLD_BOUND = 2 * Math.ceil(Math.log2(RUNS.length)) + 4; // 20 for n=159

  // Steady-state playback: hint is the current chord.
  for (const i of [0, 1, 40, 100, 158]) {
    const { proxy, stats } = counting(RUNS);
    const mid = RUNS[i].startSec + (RUNS[i].endSec - RUNS[i].startSec) / 2;
    assert.equal(activeRunIndex(proxy, mid, i), i);
    assert.ok(stats.gets <= 2, `hit on hint ${i} read ${stats.gets} elements, want <= 2`);
  }
  // The frame a chord changes: hint is one stale, the hint+1 probe catches it.
  for (const i of [1, 41, 101, 158]) {
    const { proxy, stats } = counting(RUNS);
    assert.equal(activeRunIndex(proxy, RUNS[i].startSec, i - 1), i);
    assert.ok(stats.gets <= 3, `stale-by-one hint read ${stats.gets} elements, want <= 3`);
  }
  // Cold / seek / useless hint: binary search, not a scan.
  for (const h of [undefined, null, 0, 158, 9999]) {
    for (const i of [3, 77, 150]) {
      const { proxy, stats } = counting(RUNS);
      const mid = RUNS[i].startSec + (RUNS[i].endSec - RUNS[i].startSec) / 2;
      assert.equal(activeRunIndex(proxy, mid, h), i);
      assert.ok(
        stats.gets <= COLD_BOUND,
        `cold lookup (hint ${String(h)}, target ${i}) read ${stats.gets} elements, want <= ${COLD_BOUND} (n=${RUNS.length})`,
      );
    }
  }
});

test('complexity: measured cost per lookup over a full-track 60 fps sweep', () => {
  // Not an assertion on wall-clock (that would be flaky in CI) — a printed
  // measurement so the PR carries a real number, plus a hard assertion on the
  // element-read count, which is deterministic.
  const frames = Math.floor(TRACK_SEC * 60);
  const { proxy, stats } = counting(RUNS);
  let hint = -1;
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) {
    const idx = activeRunIndex(proxy, f / 60, hint);
    if (idx !== -1) hint = idx;
  }
  const ns = Number(process.hrtime.bigint() - t0) / frames;
  const perFrame = stats.gets / frames;
  console.log(
    `    MEASURED lookup cost: ${perFrame.toFixed(3)} element reads/frame ` +
    `(linear scan would be ${RUNS.length}); ~${ns.toFixed(0)} ns/lookup over ${frames} frames`,
  );
  assert.ok(perFrame < 3, `${perFrame} element reads per frame, want < 3`);
});

// ---------------------------------------------------------------------------
// 2. The marker STEPS (Chordify), it does not slide
// ---------------------------------------------------------------------------

test('step behaviour: the marker is motionless inside a chord and jumps only at a chord change', () => {
  // This is the Chordify-vs-smooth-score decision, made executable. If the
  // marker ever interpolates with positionSec, this test fails.
  for (const i of [0, 1, 55, 158]) {
    const r = RUNS[i];
    const positions = Array.from({ length: 120 }, (_, k) => r.startSec + ((r.endSec - r.startSec) * k) / 120);
    const lefts = new Set(
      positions.map((p) => playheadGeometry(RUNS, activeRunIndex(RUNS, p), PX_PER_SEC).leftPx),
    );
    assert.equal(lefts.size, 1, `marker moved within chord ${i} (${lefts.size} distinct positions)`);
    assert.equal([...lefts][0], r.startSec * PX_PER_SEC, `chord ${i} marker not at its leading edge`);
  }
});

test('step behaviour: the marker advances strictly left to right, chord by chord', () => {
  let prev = -Infinity;
  for (let i = 0; i < RUNS.length; i++) {
    const g = playheadGeometry(RUNS, i, PX_PER_SEC);
    assert.ok(g.leftPx > prev, `marker did not advance at chord ${i}`);
    prev = g.leftPx;
  }
});

test('step behaviour: marker geometry is the chip geometry — the ring cannot drift off its chord', () => {
  for (const pps of [3.7, 10, PX_PER_SEC]) {
    for (const i of [0, 7, 99, 158]) {
      const g = playheadGeometry(RUNS, i, pps);
      const box = chipBox(RUNS[i], pps);
      assert.deepEqual({ leftPx: g.leftPx, widthPx: g.widthPx }, box, `chord ${i} at ${pps}px/s`);
      assert.equal(g.runIndex, i);
    }
  }
});

test('step behaviour: nothing sounding means NO marker (criterion 6: positionSec null renders as today)', () => {
  assert.equal(playheadGeometry(RUNS, activeRunIndex(RUNS, null), PX_PER_SEC), null);
  assert.equal(playheadGeometry(RUNS, -1, PX_PER_SEC), null);
  assert.equal(playheadGeometry(RUNS, RUNS.length, PX_PER_SEC), null);
  assert.equal(playheadGeometry(RUNS, 2.5, PX_PER_SEC), null);
  assert.equal(playheadGeometry(RUNS, NaN, PX_PER_SEC), null);
  assert.equal(playheadGeometry([], 0, PX_PER_SEC), null);
});

// ---------------------------------------------------------------------------
// 3. Auto-scroll, and not fighting the user
// ---------------------------------------------------------------------------

const VIEW = { clientWidth: 800, totalWidth: 12000 };
const at = (overrides) => ({
  activeLeftPx: 0,
  activeWidthPx: 80,
  scrollLeft: 0,
  ...VIEW,
  suspended: false,
  ...overrides,
});

test('auto-scroll: a chord comfortably inside the view scrolls nothing', () => {
  const d = resolveAutoScroll(at({ activeLeftPx: 300, scrollLeft: 200 }));
  assert.deepEqual(d, { scrollLeftTarget: null, suspended: false });
});

test('auto-scroll: a chord running off the right edge is brought back with lead room', () => {
  // Chord at 980..1060 with the view showing 200..1000: its tail is past the
  // comfortable band, so we scroll and land it 35% in, so the chords the user
  // is about to play are the ones on screen.
  const d = resolveAutoScroll(at({ activeLeftPx: 980, scrollLeft: 200 }));
  assert.equal(d.suspended, false);
  assert.equal(d.scrollLeftTarget, 980 - 800 * PLAYHEAD_LEAD_FRACTION);
  // And the sounding chord is genuinely visible afterwards, with margin.
  const after = d.scrollLeftTarget;
  assert.ok(980 >= after + PLAYHEAD_MARGIN_PX && 1060 <= after + 800 - PLAYHEAD_MARGIN_PX);
});

test('auto-scroll: after a seek backwards the chord is brought to the left margin', () => {
  const d = resolveAutoScroll(at({ activeLeftPx: 400, scrollLeft: 900 }));
  assert.equal(d.scrollLeftTarget, 400 - PLAYHEAD_MARGIN_PX);
  assert.equal(d.suspended, false);
});

test('auto-scroll: targets are clamped to the scrollable range at both ends', () => {
  // Start of the track: cannot scroll negative.
  assert.equal(resolveAutoScroll(at({ activeLeftPx: 10, scrollLeft: 500 })).scrollLeftTarget, 0);
  // End of the track: cannot scroll past totalWidth - clientWidth.
  const d = resolveAutoScroll(at({ activeLeftPx: 11_950, activeWidthPx: 50, scrollLeft: 0 }));
  assert.equal(d.scrollLeftTarget, 12000 - 800);
  // Track shorter than the viewport: the whole thing is already on screen, so
  // the clamped target is where we are and the answer is "do not scroll".
  assert.equal(
    resolveAutoScroll(at({ activeLeftPx: 700, totalWidth: 600, scrollLeft: 0 })).scrollLeftTarget,
    null,
  );
});

test('auto-scroll: a target already where we are is reported as no scroll at all', () => {
  const target = 980 - 800 * PLAYHEAD_LEAD_FRACTION;
  const d = resolveAutoScroll(at({ activeLeftPx: 980, scrollLeft: target }));
  assert.equal(d.scrollLeftTarget, null, 'must not re-assign scrollLeft every chord');
  // Within the rounding tolerance counts as unchanged, too.
  const near = resolveAutoScroll(
    at({ activeLeftPx: 980, scrollLeft: target + SCROLL_MATCH_TOLERANCE_PX }),
  );
  assert.equal(near.scrollLeftTarget, null);
});

test('auto-scroll: a degenerate viewport is left alone (pre-measurement render)', () => {
  assert.deepEqual(
    resolveAutoScroll(at({ clientWidth: 0 })),
    { scrollLeftTarget: null, suspended: false },
  );
  assert.deepEqual(
    resolveAutoScroll(at({ totalWidth: 0, suspended: true })),
    { scrollLeftTarget: null, suspended: true },
  );
});

// --- suspension: the "stop fighting the user" half of criterion 4 ----------

test('suspension: while suspended, a chord still even partly visible is NOT chased', () => {
  // The user scrolled to look at something. As long as any part of the
  // sounding chord is on screen, we do not move a pixel.
  // 121 overlaps the view by a single pixel (chord 121..201, view 200..1000);
  // 120 would end exactly ON the edge, which counts as outside — see the
  // edge-exactness test below.
  for (const left of [200, 500, 950, 999.5, 121]) {
    const d = resolveAutoScroll(at({ activeLeftPx: left, scrollLeft: 200, suspended: true }));
    assert.deepEqual(d, { scrollLeftTarget: null, suspended: true }, `chord at ${left}`);
  }
});

test('suspension: once playback leaves the visible range, following re-engages by itself', () => {
  // Ahead of the view.
  const ahead = resolveAutoScroll(at({ activeLeftPx: 4000, scrollLeft: 200, suspended: true }));
  assert.equal(ahead.suspended, false, 'suspension must lift itself');
  assert.equal(ahead.scrollLeftTarget, 4000 - 800 * PLAYHEAD_LEAD_FRACTION);
  // Behind the view (the user scrolled forward, playback is back at the start).
  const behind = resolveAutoScroll(at({ activeLeftPx: 100, scrollLeft: 3000, suspended: true }));
  assert.equal(behind.suspended, false);
  assert.equal(behind.scrollLeftTarget, 0);
});

test('suspension: the visible-range edges are exact — touching is outside, overlapping is not', () => {
  // chordEnd exactly at the left edge of the view: wholly outside -> re-engage.
  const touchLeft = resolveAutoScroll(
    at({ activeLeftPx: 920, activeWidthPx: 80, scrollLeft: 1000, suspended: true }),
  );
  assert.equal(touchLeft.suspended, false);
  // One pixel of overlap: still visible -> do not move.
  const overlap = resolveAutoScroll(
    at({ activeLeftPx: 921, activeWidthPx: 80, scrollLeft: 1000, suspended: true }),
  );
  assert.deepEqual(overlap, { scrollLeftTarget: null, suspended: true });
  // chordStart exactly at the right edge: wholly outside -> re-engage.
  const touchRight = resolveAutoScroll(
    at({ activeLeftPx: 1800, scrollLeft: 1000, suspended: true }),
  );
  assert.equal(touchRight.suspended, false);
});

test('suspension: re-engaging never reports a scroll it does not need', () => {
  // Wholly outside, but the computed target is where we already are.
  const target = 4000 - 800 * PLAYHEAD_LEAD_FRACTION;
  const d = resolveAutoScroll(
    at({ activeLeftPx: 4000, activeWidthPx: 10, scrollLeft: target, suspended: true }),
  );
  // chord at 4000 vs view 3720..4520 overlaps, so it is left alone.
  assert.deepEqual(d, { scrollLeftTarget: null, suspended: true });
});

test('manual-scroll detection: our own scrolls are not mistaken for the user, and vice versa', () => {
  // Exactly where we put it, and fractional rounding a browser may report.
  assert.equal(isManualScroll(1200, 1200), false);
  assert.equal(isManualScroll(1200.5, 1200), false);
  assert.equal(isManualScroll(1198, 1200), false);
  // A real drag / wheel / trackpad scroll.
  assert.equal(isManualScroll(1400, 1200), true);
  assert.equal(isManualScroll(0, 1200), true);
  assert.equal(isManualScroll(1203, 1200), true);
  // Garbage never suspends following.
  assert.equal(isManualScroll(NaN, 1200), false);
  assert.equal(isManualScroll(1200, NaN), false);
  assert.equal(isManualScroll(Infinity, 1200), false);
});

test('suspension round trip: play, user scrolls away, we back off, playback passes, we resume', () => {
  // The whole criterion-4 story in one pass, driven through the same two pure
  // functions the component calls.
  let scrollLeft = 0;
  let lastAuto = 0;
  let suspended = false;
  const step = (positionSec) => {
    const idx = activeRunIndex(RUNS, positionSec);
    const g = playheadGeometry(RUNS, idx, PX_PER_SEC);
    if (!g) return;
    const d = resolveAutoScroll({
      activeLeftPx: g.leftPx,
      activeWidthPx: g.widthPx,
      scrollLeft,
      clientWidth: 800,
      totalWidth: Math.ceil(TRACK_SEC * PX_PER_SEC),
      suspended,
    });
    suspended = d.suspended;
    if (d.scrollLeftTarget !== null) {
      lastAuto = d.scrollLeftTarget;
      scrollLeft = d.scrollLeftTarget;
    }
  };

  // 1. Playing from the top: following keeps the chord on screen.
  for (let t = 0; t < 30; t += 0.25) step(t);
  assert.equal(suspended, false);
  const followedTo = scrollLeft;
  assert.ok(followedTo > 0, 'auto-scroll followed playback');
  const soundingAt30 = playheadGeometry(RUNS, activeRunIndex(RUNS, 30), PX_PER_SEC);
  assert.ok(
    soundingAt30.leftPx >= scrollLeft && soundingAt30.leftPx <= scrollLeft + 800,
    'the sounding chord is visible',
  );

  // 2. The user drags the view somewhere else.
  scrollLeft = followedTo + 400;
  assert.equal(isManualScroll(scrollLeft, lastAuto), true, 'detected as the user');
  suspended = true;
  const parked = scrollLeft;

  // 3. Playback continues nearby: we must not move. (Chords around 30-35 s
  //    still overlap the parked view.)
  for (let t = 30; t < 35; t += 0.25) step(t);
  assert.equal(scrollLeft, parked, 'auto-scroll fought the user');
  assert.equal(suspended, true, 'suspension lifted too early');

  // 4. Playback runs well past the parked view: following resumes.
  for (let t = 35; t < 90; t += 0.25) step(t);
  assert.equal(suspended, false, 'suspension never lifted');
  assert.notEqual(scrollLeft, parked);
  const soundingAt90 = playheadGeometry(RUNS, activeRunIndex(RUNS, 89.75), PX_PER_SEC);
  assert.ok(
    soundingAt90.leftPx >= scrollLeft && soundingAt90.leftPx <= scrollLeft + 800,
    'the sounding chord is visible again',
  );
});

// ---------------------------------------------------------------------------
// The live page must keep working unchanged
// ---------------------------------------------------------------------------

test('the live mount now carries positionSec, and positionSec is still optional', () => {
  // UPDATED BY THE SEAM PR. The original form of this test asserted that
  // /jobs/[id] "still passes jobId and nothing else" — a SCOPING guard for
  // PR #187, which landed `positionSec` as an additive, optional prop and
  // deliberately did not wire it. The seam PR is the change that guard was
  // waiting for: the engine now lives in components/play/Player.tsx, and the
  // chord track is mounted there with the engine's own position. What the
  // guard was really protecting — that `positionSec` stays OPTIONAL, and that
  // ChordOverlay never grows a transport of its own — is kept below.
  const player = readFileSync(
    join(import.meta.dirname, '..', 'src/components/play/Player.tsx'),
    'utf8',
  );
  assert.match(
    player,
    /<ChordOverlay\s+jobId=\{jobId\}\s+positionSec=\{chordPosition\}\s*\/>/,
    'the chord playhead is not wired to the engine position',
  );

  // Still optional, with a null default: nothing else in the app is forced to
  // pass it, and a mount without it renders exactly as it did before.
  const overlay = readFileSync(
    join(import.meta.dirname, '..', 'src/components/ChordOverlay.tsx'),
    'utf8',
  );
  assert.match(overlay, /positionSec = null/, 'positionSec must keep its null default');

  // The job body must not mount a SECOND, position-less overlay beside the
  // Player's. Checking page.tsx for this was vacuous — it is a Server
  // Component that renders only <JobView/> and could not mount the overlay if
  // it tried. JobView is the file that could reintroduce the original bug, so
  // that is the file to hold to it.
  //
  // Comments AND literals are blanked before matching, and that is NOT
  // incidental — this one assertion has been a false green twice:
  //   round 2: read raw, JobView's own header comment names `<Player>` twice,
  //            so deleting the real mount left this test 31/31 green;
  //   round 3: with comments stripped but literals intact,
  //            `<span title={'<Player jobId={job.id} … />'} />` satisfied the
  //            tightened pattern with the mount deleted — and a `//` inside
  //            `aria-label="chords//legacy"` deleted the rest of the line, so
  //            the `doesNotMatch` below reported success WITHOUT CHECKING
  //            while a real second position-less overlay was mounted.
  // `codeOnly` is a single-pass scanner that closes both directions; see
  // test/helpers/code-only.mjs for why reordering regexes could not.
  //
  // Both of these are now ALSO asserted on rendered output in
  // test/job-page-render.test.mjs, which is the layer a source-text trick
  // cannot reach at all. These stay as the cheap, fast guard.
  const jobView = codeOnly(
    readFileSync(join(import.meta.dirname, '..', 'src/app/jobs/[id]/JobView.tsx'), 'utf8'),
  );
  assert.doesNotMatch(
    jobView,
    /<ChordOverlay/,
    'the job body mounts its own overlay again; only Player has a position to give it',
  );
  assert.match(
    jobView,
    /<Player\s+jobId=/,
    'the job body stopped mounting the Player (code, not a comment that names it)',
  );
});

test('the zoom slider is still the zoom slider: the playhead adds no second range input', () => {
  // The named trap. ChordOverlay has exactly ONE <input type="range">, it is
  // the zoom control, and the playhead must not have turned it (or added
  // anything else) into a seek bar. Track 3B owns the real transport.
  const src = readFileSync(join(import.meta.dirname, '..', 'src/components/ChordOverlay.tsx'), 'utf8');
  const ranges = src.match(/type="range"/g) ?? [];
  assert.equal(ranges.length, 1, 'there must be exactly one range input');
  assert.match(src, /aria-label="Timeline zoom"/);
  assert.match(src, /data-testid="zoom-slider"/);
  assert.doesNotMatch(src, /onSeek/, 'the playhead must not expose a seek callback');
  // The marker is an indicator, not a control.
  assert.match(src, /playheadLineStyle[\s\S]*?pointerEvents: 'none'/);
});
