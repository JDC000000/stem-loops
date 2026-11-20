// QA-68: every chip of the wrapped chord chart ("See all chords" on a phone)
// is at least CHIP_MIN_TAP_PX wide when rendered. Chips do not overlap, they
// stay inside their row and in time order, and no chord is merged or dropped.
// The real-Chromium half of this is packages/web-browser-gate/test/chord-sheet-tap.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHIP_GAP_PX,
  CHIP_MIN_BOX_PX,
  CHIP_MIN_TAP_PX,
  MAX_PX_PER_SEC,
  MAX_WRAP_ROWS,
  chipContentPx,
  durationSec,
  estimateLabelPx,
  fitRowSegments,
  fitRowsToTap,
  layoutRows,
  layoutTapRows,
  observationsToRuns,
  wrapPaintBudgetPx,
  zoomCeilingPxPerSec,
} from '../ChordOverlay.helpers.ts';

const seg = (runIndex, leftPx, widthPx, continued = false) => ({ runIndex, leftPx, widthPx, continued });

function song(durs) {
  let t = 0;
  const labels = ['C:maj', 'F:maj', 'G:maj', 'A:min'];
  return observationsToRuns(
    durs.map((d, i) => {
      const o = { startSec: t, endSec: t + d, label: labels[i % labels.length], confidence: 1 };
      t += d;
      return o;
    }),
  );
}

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** Every invariant the chart promises, checked on one layout. */
function checkTapRows(rows, base, rowWidthPx, ctx) {
  // Nothing merged or dropped: the same (run, piece) multiset as layoutRows.
  const key = (s) => `${s.runIndex}:${s.continued}`;
  const want = base.flatMap((r) => r.segments.map(key)).sort();
  const got = rows.flatMap((r) => r.segments.map(key)).sort();
  assert.deepEqual(got, want, `chips lost or invented @ ${ctx}`);
  let lastRun = -1;
  let lastStart = -Infinity;
  for (const [ri, row] of rows.entries()) {
    assert.ok(row.startSec >= lastStart - 1e-9, `row ${ri} starts before the row above @ ${ctx}`);
    lastStart = row.startSec;
    let right = 0;
    for (const s of row.segments) {
      const w = chipContentPx(s.widthPx); // what renderChip draws
      assert.ok(w >= CHIP_MIN_TAP_PX, `run ${s.runIndex} renders ${w.toFixed(3)}px < ${CHIP_MIN_TAP_PX} @ ${ctx}`);
      assert.ok(s.leftPx >= right - 1e-9, `run ${s.runIndex} overlaps its left neighbour @ ${ctx}`);
      assert.ok(s.leftPx >= -1e-9 && s.leftPx + s.widthPx <= rowWidthPx + 1e-6, `run ${s.runIndex} leaves its row @ ${ctx}`);
      assert.ok(s.runIndex >= lastRun, `time order broken at run ${s.runIndex} @ ${ctx}`);
      lastRun = s.runIndex;
      right = s.leftPx + s.widthPx;
    }
  }
}

test('QA-68: the floor is the brand tap floor, and a box leaves room for the gap', () => {
  assert.equal(CHIP_MIN_TAP_PX, 24);
  assert.ok(CHIP_MIN_BOX_PX > CHIP_MIN_TAP_PX + CHIP_GAP_PX);
  // More than one Chromium LayoutUnit of slack, so float error cannot render 23.984px.
  assert.ok(CHIP_MIN_BOX_PX - CHIP_MIN_TAP_PX - CHIP_GAP_PX > 1 / 64);
  assert.ok(chipContentPx(CHIP_MIN_BOX_PX) >= CHIP_MIN_TAP_PX);
});

test('fitRowSegments: a row whose chips are all wide enough is left where it was', () => {
  const segs = [seg(0, 0, 60), seg(1, 60, 40), seg(2, 130, 90)]; // a 30px gap in the data
  const out = fitRowSegments(segs, 300);
  for (const [i, s] of out.entries()) {
    assert.ok(Math.abs(s.leftPx - segs[i].leftPx) < 1e-9);
    assert.ok(Math.abs(s.widthPx - segs[i].widthPx) < 1e-9);
  }
});

test('fitRowSegments: a 5px chord widens to the floor and its long neighbours pay', () => {
  const out = fitRowSegments([seg(0, 0, 100), seg(1, 100, 5), seg(2, 105, 195)], 300);
  const [a, b, c] = out;
  assert.ok(chipContentPx(b.widthPx) >= CHIP_MIN_TAP_PX, `short chip is ${b.widthPx}`);
  assert.equal(a.leftPx, 0);
  assert.ok(Math.abs(a.leftPx + a.widthPx - b.leftPx) < 1e-9 && Math.abs(b.leftPx + b.widthPx - c.leftPx) < 1e-9);
  assert.ok(Math.abs(c.leftPx + c.widthPx - 300) < 1e-9, 'the row end did not move');
  // The least-squares split: both boundaries move by the same ~10px.
  assert.ok(Math.abs(a.widthPx - (100 - (CHIP_MIN_BOX_PX - 5) / 2)) < 1e-9, `left neighbour ${a.widthPx}`);
  assert.ok(c.widthPx > 180, 'the long chord stays long');
});

test('fitRowSegments: a gap in the chord data can shrink but never goes negative', () => {
  const out = fitRowSegments([seg(0, 0, 2), seg(1, 10, 2), seg(2, 20, 2)], 100);
  let right = 0;
  for (const s of out) {
    assert.ok(s.leftPx >= right - 1e-9);
    assert.ok(chipContentPx(s.widthPx) >= CHIP_MIN_TAP_PX);
    right = s.leftPx + s.widthPx;
  }
  assert.ok(right <= 100 + 1e-9);
});

test('fitRowSegments: zero-length chips and a row end at the edge still get the floor', () => {
  const out = fitRowSegments([seg(0, 0, 0), seg(1, 0, 0), seg(2, 299, 1)], 300);
  for (const s of out) assert.ok(chipContentPx(s.widthPx) >= CHIP_MIN_TAP_PX);
  assert.ok(out[2].leftPx + out[2].widthPx <= 300 + 1e-9);
});

test('fitRowsToTap: an over-full row is split into rows that start at their own first chord', () => {
  // 20 chords of 0.25s in one 8s row of 200px: at most 7 fit, so 3 rows.
  const runs = song(Array(20).fill(0.25).concat([3]));
  const pps = 25;
  const base = layoutRows(runs, 8, pps);
  const rows = fitRowsToTap(base, 200, pps);
  assert.equal(base.length, 1);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].startSec, 0);
  for (const row of rows.slice(1)) {
    const first = runs[row.segments[0].runIndex];
    assert.ok(Math.abs(row.startSec - first.startSec) < 1e-9, `row starts at ${row.startSec}, its first chord at ${first.startSec}`);
  }
  // Balanced, not 7 + 7 + 7.
  assert.deepEqual(rows.map((r) => r.segments.length), [7, 7, 7]);
  checkTapRows(rows, base, 200, 'split');
});

test('fitRowsToTap: a run split across rows keeps its continuation flag', () => {
  const runs = song([0.1, 7.95, 0.1, 4]);
  const base = layoutRows(runs, 8, 30);
  const rows = fitRowsToTap(base, 240, 30);
  const cont = rows.flatMap((r) => r.segments).filter((s) => s.continued);
  assert.equal(cont.length, 1);
  checkTapRows(rows, base, 240, 'continued');
});

test('QA-68 fuzz: every chip >= 24px, no overlap, in its row, in order, nothing lost', () => {
  let checked = 0;
  let splitRows = 0;
  for (let it = 0; it < 120; it++) {
    const n = 10 + Math.floor(rnd() * 150);
    const durs = Array.from({ length: n }, () => {
      const r = rnd();
      return r < 0.15 ? 0.02 + rnd() * 0.1 : r < 0.6 ? 0.2 + rnd() * 0.6 : 0.8 + rnd() * 4;
    });
    const runs = song(durs);
    // Row widths of the chart at 320-430px viewports (and a bit either side).
    for (const rowWidthPx of [180, 200, 216, 246, 270, 300, 330]) {
      const ceiling = zoomCeilingPxPerSec(runs, estimateLabelPx, {
        durSec: durationSec(runs),
        maxPaintedPx: wrapPaintBudgetPx(runs.length, rowWidthPx),
      });
      for (const pps of [rowWidthPx / 16, rowWidthPx / 7, MAX_PX_PER_SEC, ceiling]) {
        const base = layoutRows(runs, rowWidthPx / pps, pps);
        const rows = layoutTapRows(runs, rowWidthPx / pps, pps, rowWidthPx);
        splitRows += rows.length - base.length;
        checkTapRows(rows, base, rowWidthPx, `n=${n} row=${rowWidthPx} pps=${pps.toFixed(2)}`);
        checked += rows.reduce((a, r) => a + r.segments.length, 0);
      }
    }
  }
  assert.ok(checked > 100_000, `only ${checked} chips checked`);
  assert.ok(splitRows > 0, 'the fuzz never split a row, so it did not test splitting');
});

test('wrapPaintBudgetPx: split rows never take the DOM past MAX_WRAP_ROWS at the ceiling', () => {
  for (const rowWidthPx of [180, 246, 346]) {
    for (const runs of [song(Array(20).fill(0.02).concat([299.6])), song(Array(400).fill(0.05).concat([200])), song(Array(3000).fill(0.1))]) {
      const ceiling = zoomCeilingPxPerSec(runs, estimateLabelPx, {
        durSec: durationSec(runs),
        maxPaintedPx: wrapPaintBudgetPx(runs.length, rowWidthPx),
      });
      const rows = layoutTapRows(runs, rowWidthPx / ceiling, ceiling, rowWidthPx).length;
      assert.ok(rows <= MAX_WRAP_ROWS, `${runs.length} runs @ ${rowWidthPx}px: ${rows} rows at the ceiling`);
    }
  }
  // It is a reserve, not a new cap: never more than MAX_WRAP_ROWS rows of paint.
  assert.ok(wrapPaintBudgetPx(0, 300) <= MAX_WRAP_ROWS * 300);
});
