// QA-73: the strip ("See all chords" and the chord timeline on tablets and
// desktop, container >= NARROW_BREAKPOINT_PX) gives every chord a chip at least
// MIN_TAP_PX wide, and its ruler and playhead stay true to the chips. Also: one
// tap floor for every chord surface, and exact gutter times on split rows.
// The real-Chromium half is packages/web-browser-gate/test/chord-sheet-tap.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_TAP_PX } from '../tapTarget.ts';
import {
  CHIP_MIN_BOX_PX,
  MAX_PX_PER_SEC,
  chipBox,
  chipContentPx,
  durationSec,
  estimateLabelPx,
  fitPxPerSec,
  fitRowsToTap,
  formatTime,
  layoutRows,
  layoutTapRows,
  layoutTapStrip,
  longChordSec,
  observationsToRuns,
  rulerTicks,
  STRIP_LONG_CHORD_RATIO,
  stripCentreSec,
  stripMinPxPerSec,
  stripPxToTime,
  stripRulerTicks,
  stripScrollLeftForCentre,
  stripTimeToPx,
  stripVisibleSec,
  stripWidthAt,
  zoomCeilingPxPerSec,
} from '../ChordOverlay.helpers.ts';

function song(durs, gapEvery = 0) {
  let t = 0.5;
  const labels = ['C:maj', 'F:maj', 'G:maj', 'A:min', 'C#:hdim7/5'];
  return observationsToRuns(
    durs.map((d, i) => {
      if (gapEvery && i > 0 && i % gapEvery === 0) t += 0.7; // a stretch with no chord
      const o = { startSec: t, endSec: t + d, label: labels[i % labels.length], confidence: 1 };
      t += d;
      return o;
    }),
  );
}

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** Every promise the strip makes, on one layout. */
const r0 = (r) => ({ startSec: Math.max(0, r.startSec), endSec: Math.max(Math.max(0, r.startSec), r.endSec) });
function checkStrip(runs, pps, ctx) {
  const s = layoutTapStrip(runs, pps);
  // Additive: the song's length plus exactly what the short chips lacked.
  const deficit = runs.reduce((a, r) => a + Math.max(0, CHIP_MIN_BOX_PX - (r0(r).endSec - r0(r).startSec) * pps), 0);
  assert.ok(Math.abs(s.widthPx - (durationSec(runs) * pps + deficit)) < 1e-6 * Math.max(1, s.widthPx), `strip ${s.widthPx}px, want song + deficits ${durationSec(runs) * pps + deficit} @ ${ctx}`);
  assert.equal(s.boxes.length, runs.length, `one box per chord @ ${ctx}`);
  assert.ok(s.widthPx >= durationSec(runs) * pps - 1e-6, `strip shorter than the song @ ${ctx}`);
  const order = runs.map((_, i) => i).sort((a, b) => runs[a].startSec - runs[b].startSec || a - b);
  let right = 0;
  for (const i of order) {
    const b = s.boxes[i];
    const w = chipContentPx(b.widthPx); // what renderChip draws
    assert.ok(w >= MIN_TAP_PX, `chord ${i} renders ${w.toFixed(3)}px < ${MIN_TAP_PX} @ ${ctx}`);
    assert.ok(b.leftPx >= right - 1e-6, `chord ${i} overlaps its left neighbour @ ${ctx}`);
    assert.ok(b.leftPx >= -1e-9 && b.leftPx + b.widthPx <= s.widthPx + 1e-6, `chord ${i} leaves the strip @ ${ctx}`);
    right = b.leftPx + b.widthPx;
    // M-1: a chord that is already wide enough keeps its TRUE width; a short
    // one gets exactly the box, never more. Nothing gives up width.
    const prop = Math.max(0, r0(runs[i]).endSec - r0(runs[i]).startSec) * pps;
    if (prop >= CHIP_MIN_BOX_PX) assert.equal(b.widthPx, prop, `chord ${i} is ${b.widthPx}px, proportional ${prop}px @ ${ctx}`);
    else assert.equal(b.widthPx, CHIP_MIN_BOX_PX, `short chord ${i} is ${b.widthPx}px, not the box @ ${ctx}`);
    // The time map puts the chord's own span on its own chip.
    const r = runs[i];
    const mid = (r.startSec + r.endSec) / 2;
    const x = stripTimeToPx(s, mid);
    assert.ok(x >= b.leftPx - 1e-6 && x <= b.leftPx + b.widthPx + 1e-6, `time ${mid.toFixed(3)} drawn off chord ${i}'s chip @ ${ctx}`);
    assert.ok(Math.abs(stripPxToTime(s, x) - mid) < 1e-6, `px -> time is not the inverse on chord ${i} @ ${ctx}`);
  }
  for (let k = 1; k < s.knotSec.length; k++) {
    assert.ok(s.knotSec[k] >= s.knotSec[k - 1] && s.knotPx[k] >= s.knotPx[k - 1], `time map not monotone @ ${ctx}`);
  }
  return s;
}

test('QA-73: MIN_TAP_PX is 24, and CHIP_MIN_BOX_PX is built on it', () => {
  assert.equal(MIN_TAP_PX, 24);
  assert.ok(chipContentPx(CHIP_MIN_BOX_PX) >= MIN_TAP_PX);
});

test('QA-73: one tap floor. No other source file defines a tap-size constant', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '../..');
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n !== '__tests__' && n !== 'node_modules') walk(p);
      } else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(src);
  assert.ok(files.length > 50, `only ${files.length} source files scanned`);
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // Any casing: MIN_TAP_PX, minTapPx, tapMin, chipTapFloor ... with a number.
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w*tap\w*)\s*(?::[^=]+)?=\s*(\d[\d.]*)/gi)) {
      if (!f.endsWith(join('components', 'tapTarget.ts'))) offenders.push(`${relative(src, f)}: ${m[1]} = ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [], 'define the tap floor once, in src/components/tapTarget.ts');
});

test('QA-73 layoutTapStrip: a strip already wide enough is drawn where chipBox puts it', () => {
  const runs = song([2, 1.5, 3, 0.75, 2.5]);
  const pps = 60; // shortest chip 45px
  const s = layoutTapStrip(runs, pps);
  runs.forEach((r, i) => {
    const b = chipBox(r, pps);
    assert.ok(Math.abs(s.boxes[i].leftPx - b.leftPx) < 1e-6 && Math.abs(s.boxes[i].widthPx - b.widthPx) < 1e-6, `chord ${i} moved`);
  });
  for (const t of [0, 1, 3.3, 7]) assert.ok(Math.abs(stripTimeToPx(s, t) - t * pps) < 1e-6, `t=${t} is not linear`);
});

test('QA-73 layoutTapStrip (M-1): half-beat chords widen to the box ADDITIVELY; long chords keep their true width', () => {
  // The QA-01 shape: 0.3s chords between 2s chords at 17.5px/s (the strip's
  // default zoom on that song, measured): 5.25px chips before the fix.
  const runs = song([2.1, 0.3, 2.4, 1.2, 0.9, 0.3, 0.3, 2.1]);
  const s = checkStrip(runs, 17.5, 'qa01 shape');
  assert.ok(chipBox(runs[1], 17.5).widthPx < 6);
  assert.equal(s.boxes[1].widthPx, CHIP_MIN_BOX_PX);
  // The 2.1s and 2.4s chords are exactly 36.75 and 42px, as without the fix,
  // and the 2.1s chord is drawn wider than the 0.3s one.
  assert.equal(s.boxes[0].widthPx, 2.1 * 17.5);
  assert.equal(s.boxes[2].widthPx, 2.4 * 17.5);
  assert.ok(s.boxes[0].widthPx > s.boxes[1].widthPx + 10);
  // Later chips moved right by exactly the deficits before them.
  const d = CHIP_MIN_BOX_PX - 0.3 * 17.5;
  assert.ok(Math.abs(s.boxes[2].leftPx - (runs[2].startSec * 17.5 + d)) < 1e-9);
});

test('QA-73 stripMinPxPerSec: a song that fits at 24px per chip fits the screen at the zoom-out end, as wide as it can', () => {
  for (const viewport of [720, 976, 1392]) {
    for (const n of [4, 12, Math.floor(viewport / CHIP_MIN_BOX_PX)]) {
      const runs = song(Array.from({ length: n }, () => 0.1 + rnd() * 4));
      const floor = stripMinPxPerSec(runs, viewport);
      const w = stripWidthAt(runs, floor);
      assert.ok(w <= viewport + 1e-6, `n=${n} @ ${viewport}: ${w}px at the floor does not fit`);
      // Maximal: a hair more zoom no longer fits, unless the floor is the
      // whole-track cap itself.
      const cap = Math.min(MAX_PX_PER_SEC, viewport / durationSec(runs));
      if (floor < cap * (1 - 1e-6)) assert.ok(stripWidthAt(runs, floor * 1.001) > viewport, `n=${n} @ ${viewport}: the floor is not the widest fit`);
      checkStrip(runs, floor, `fit n=${n} @ ${viewport}`);
    }
  }
});

test('QA-73 stripMinPxPerSec: a song that cannot fit scrolls, and its long chords stay clearly longer than short ones', () => {
  for (const n of [60, 154, 400]) {
    const runs = song(Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 2 + rnd() * 2 : 0.2 + rnd() * 0.3)));
    for (const viewport of [720, 976, 1392]) {
      assert.ok(n * CHIP_MIN_BOX_PX > viewport);
      const floor = stripMinPxPerSec(runs, viewport);
      const s = checkStrip(runs, floor, `scroll n=${n} @ ${viewport}`);
      const long = longChordSec(runs);
      const longest = Math.max(...runs.map((r, i) => (r.endSec - r.startSec >= long - 1e-9 ? s.boxes[i].widthPx : 0)));
      assert.ok(longest >= STRIP_LONG_CHORD_RATIO * CHIP_MIN_BOX_PX - 1e-6, `long chords ${longest}px at the floor`);
      const widths = s.boxes.map((b) => b.widthPx);
      assert.ok(Math.max(...widths) >= 1.5 * Math.min(...widths) - 1e-6, 'durations vanished at the floor');
      assert.ok(floor >= fitPxPerSec(durationSec(runs), viewport));
    }
  }
  assert.equal(longChordSec([]), 0);
  // Time-weighted: one 60s intro chord does not set "long" for 100 bar chords.
  assert.equal(longChordSec(song([60, ...Array(100).fill(2)])), 2);
});

test('QA-73 layoutTapStrip fuzz: >= 24px, no overlap, in order, ruler on its chord, at every zoom', () => {
  let checked = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 5 + Math.floor(rnd() * 300);
    const kind = trial % 3;
    const durs = Array.from({ length: n }, () =>
      kind === 0 ? 0.1 + rnd() * 3 : kind === 1 ? (rnd() < 0.7 ? 0.05 + rnd() * 0.3 : 2 + rnd() * 6) : 0.25 * (1 + Math.floor(rnd() * 8)),
    );
    const runs = song(durs, trial % 4 === 0 ? 7 : 0);
    const dur = durationSec(runs);
    const minPps = stripMinPxPerSec(runs, 1024);
    const ceiling = Math.max(zoomCeilingPxPerSec(runs, estimateLabelPx, { durSec: dur }), minPps);
    for (const pps of [minPps, (minPps + MAX_PX_PER_SEC) / 2, MAX_PX_PER_SEC, ceiling, minPps / 3]) {
      const s = checkStrip(runs, pps, `trial ${trial} n=${n} pps=${pps.toFixed(2)}`);
      // Ticks: every kept tick is drawn inside the chip of the chord heard at
      // its time (or in the gap it falls in), and kept ticks never collide.
      const ticks = stripRulerTicks(s, dur, pps);
      assert.ok(ticks.length >= 1);
      for (let k = 0; k < ticks.length; k++) {
        const t = ticks[k];
        if (k > 0) assert.ok(t.leftPx - ticks[k - 1].leftPx >= 40 - 1e-9, 'ticks collide');
        const i = runs.findIndex((r) => r.startSec <= t.sec && t.sec < r.endSec);
        if (i >= 0) {
          const b = s.boxes[i];
          assert.ok(t.leftPx >= b.leftPx - 1e-6 && t.leftPx <= b.leftPx + b.widthPx + 1e-6, `tick ${t.label} off chord ${i}`);
        }
      }
      checked += runs.length;
    }
  }
  assert.ok(checked > 20_000, `only ${checked} chips checked`);
});

test('QA-73 stripRulerTicks: same times and labels as rulerTicks where nothing was widened', () => {
  const runs = song([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  const s = layoutTapStrip(runs, 40);
  assert.deepEqual(
    stripRulerTicks(s, durationSec(runs), 40).map((t) => [t.sec, t.label, Math.round(t.leftPx * 1e6) / 1e6]),
    rulerTicks(durationSec(runs), 40).map((t) => [t.sec, t.label, Math.round(t.leftPx * 1e6) / 1e6]),
  );
});

test('QA-73 (#324 m-4): a split row\'s gutter time is its first chip\'s start, exactly', () => {
  // Chords on whole seconds, where row start + px / pps can land a hair under
  // the integer and floor "0:12" to "0:11".
  const runs = observationsToRuns(
    Array.from({ length: 120 }, (_, i) => ({ startSec: i * 0.25, endSec: (i + 1) * 0.25, label: i % 2 ? 'C:maj' : 'G:maj', confidence: 1 })),
  );
  // 180 / 13 and 180 / 7 put a split on 3s, 5s and 10s, where px / pps gives
  // 2.9999999999999996, 4.999999999999999 and 9.999999999999998 (measured).
  for (const [rowWidthPx, pps] of [[180, 180 / 13], [180, 180 / 7], [183, 183 / 13], [246, 246 / 16], [276, 276 / 16], [346, 346 / 7], [246, 13.75], [302, 302 / 13]]) {
    const rows = layoutTapRows(runs, rowWidthPx / pps, pps, rowWidthPx);
    const base = layoutRows(runs, rowWidthPx / pps, pps);
    assert.ok(rows.length > base.length, `no split at ${rowWidthPx}px, ${pps}px/s`);
    for (const row of rows) {
      const first = row.segments[0];
      if (!first || first.continued) continue;
      const want = runs[first.runIndex].startSec;
      if (row.startSec !== 0 || want !== 0)
        assert.ok(row.startSec <= want + 1e-12, `row at ${row.startSec} begins after its first chip at ${want}`);
      if (rows.indexOf(row) > 0 && base.every((b) => Math.abs(b.startSec - row.startSec) > 1e-9))
        assert.equal(formatTime(row.startSec), formatTime(want), `split row labelled ${formatTime(row.startSec)}, first chip at ${want}s`);
    }
  }
});

test('QA-73: fitRowsToTap falls back to px / pps for hand-built segments without startSec', () => {
  const segs = Array.from({ length: 12 }, (_, i) => ({ runIndex: i, leftPx: i * 10, widthPx: 10, continued: false }));
  const rows = fitRowsToTap([{ startSec: 0, segments: segs }], 100, 10);
  assert.ok(rows.length > 1);
  assert.ok(rows[1].startSec > 0 && Math.abs(rows[1].startSec * 10 - segs.find((s) => s.runIndex === rows[1].segments[0].runIndex).leftPx) < 1e-9);
});

test('QA-73 (m-2) stripVisibleSec: "Showing a–b" reads the times AT the viewport edges, not px / zoom', () => {
  const runs = song([2.1, 0.3, 2.4, 1.2, 0.9, 0.3, 0.3, 2.1, 0.3, 0.3, 0.3, 2.4]);
  const pps = 17.5;
  const s = layoutTapStrip(runs, pps);
  for (const [i, r] of runs.entries()) {
    // Viewport starting exactly at chord i's chip: the hint's "a" is its start.
    const [a, b] = stripVisibleSec(s, s.boxes[i].leftPx, 300);
    assert.ok(Math.abs(a - r.startSec) < 1e-9, `chord ${i}: a=${a}, start ${r.startSec}`);
    assert.ok(Math.abs(stripTimeToPx(s, b) - (s.boxes[i].leftPx + 300)) < 1e-6 || b === durationSec(runs));
  }
  // And it is not the linear reading once chips were widened.
  const last = runs.length - 1;
  assert.ok(stripVisibleSec(s, s.boxes[last].leftPx, 10)[0] < s.boxes[last].leftPx / pps - 1, 'the deficits did not move the hint');
});

test('QA-73 (m-2) zoom centring: the chord at the centre stays at the centre through a zoom', () => {
  const runs = song(Array.from({ length: 200 }, (_, i) => (i % 4 === 3 ? 2.4 : 0.3)));
  for (const [p1, p2] of [[12, 18], [18, 12], [12, 60], [60, 12], [25, 26]]) {
    const s1 = layoutTapStrip(runs, p1);
    const s2 = layoutTapStrip(runs, p2);
    for (const i of [10, 57, 101, 150, 199]) {
      const clientWidth = 900;
      const mid = s1.boxes[i].leftPx + s1.boxes[i].widthPx / 2;
      const left1 = mid - clientWidth / 2;
      const c = stripCentreSec(s1, left1, clientWidth);
      assert.ok(c >= runs[i].startSec && c <= runs[i].endSec, `p=${p1}: the centre ${c}s is not in chord ${i}`);
      const left2 = stripScrollLeftForCentre(s2, c, clientWidth);
      const at = left2 + clientWidth / 2;
      if (left2 > 0) assert.ok(at >= s2.boxes[i].leftPx - 1e-6 && at <= s2.boxes[i].leftPx + s2.boxes[i].widthPx + 1e-6, `${p1}->${p2}: chord ${i} left the centre`);
      // The linear reading would land elsewhere: the deficits are many chords' worth here.
      if (i > 50) assert.ok(Math.abs(mid / p1 - c) > 1, `${p1}: linear and mapped centres agree, the test proves nothing`);
    }
  }
  assert.equal(stripScrollLeftForCentre(layoutTapStrip(runs, 20), 0, 900), 0);
});
