// Unit tests for ChordOverlay via its pure helpers.
//
// The component itself is a `.tsx` file and Node's --experimental-strip-types
// loader does not accept `.tsx`. Full render + interaction tests move to the
// Playwright e2e in apps/web/e2e/chord-overlay-safari.spec.ts once that
// harness is wired up. See the PR description for the plan.
//
// What we assert here:
//   - `buildChordEdit` produces the payload the Y1.7 edit-collector expects.
//   - `popoverAlternatives` returns the 10 nearest Harte alternatives.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChordEdit,
  chipBox,
  completedJobStatus,
  unavailableMessage,
  classifyLabel,
  displayText,
  observationsToRuns,
  popoverAlternatives,
  runAriaLabel,
  timelineWidthPx,
  PX_PER_SEC,
  MAX_PX_PER_SEC,
  chordAlternatives,
  buildChordLabelEdit,
  durationSec,
  fitPxPerSec,
  clampPxPerSec,
  ppsToSlider,
  sliderToPps,
  rulerTicks,
  layoutRows,
  chipDensity,
  formatTime,
} from '../ChordOverlay.helpers.ts';
import { chordLabel } from '../../chord/alphabet.ts';

test('buildChordEdit: carries startFrame, endFrame, original + new class, and timestamp', () => {
  // ChordRun shape (post-PR-Y1.sec-T1): chordClass + label, startSec/endSec
  // are present but not consumed by buildChordEdit.
  const run = {
    chordClass: 3,
    startFrame: 10,
    endFrame: 20,
    startSec: 0.93,
    endSec: 1.86,
    label: 'C:min7',
  };
  const edit = buildChordEdit(run, 7, () => 1700000000000);
  assert.deepEqual(edit, {
    startFrame: 10,
    endFrame: 20,
    originalCls: 3,
    newCls: 7,
    timestampMs: 1700000000000,
  });
});

test('buildChordEdit: uses Date.now() when no clock is injected', () => {
  const before = Date.now();
  const edit = buildChordEdit(
    {
      chordClass: 1,
      startFrame: 0,
      endFrame: 1,
      startSec: 0,
      endSec: 0.093,
      label: 'C:min',
    },
    2,
  );
  const after = Date.now();
  assert.ok(edit.timestampMs >= before && edit.timestampMs <= after);
});

test('popoverAlternatives: returns exactly 10 distinct non-self alternatives', () => {
  const alts = popoverAlternatives(12, 10);
  assert.equal(alts.length, 10);
  assert.equal(new Set(alts).size, 10);
  assert.ok(!alts.includes(12));
});

test('popoverAlternatives: k=3 yields 3 options', () => {
  const alts = popoverAlternatives(0, 3);
  assert.equal(alts.length, 3);
});

// ---------------- full-vocabulary rendering ----------------

const obs = (label, startSec, endSec) => ({ startSec, endSec, label, confidence: 1 });
const MIXED = [
  obs('C:maj', 0, 2),
  obs('G:7/5', 2, 4),
  obs('A:min/b3', 4, 6),
  obs('F:maj9', 6, 8),
  obs('N', 8, 10),
  obs('X', 10, 12),
  obs('C', 12, 14),
];

test('observationsToRuns: every observation yields a run, none dropped', () => {
  const runs = observationsToRuns(MIXED);
  assert.equal(runs.length, MIXED.length);
  assert.deepEqual(runs.map((r) => r.label), MIXED.map((o) => o.label));
});

test('observationsToRuns: out-of-vocabulary labels keep the string, chordClass is null (never -1)', () => {
  const runs = observationsToRuns(MIXED);
  for (const r of runs.filter((r) => ['G:7/5', 'A:min/b3', 'F:maj9', 'N', 'X', 'C'].includes(r.label))) {
    assert.equal(r.chordClass, null, r.label);
  }
  assert.equal(runs[0].chordClass, 0); // C:maj is in the flat vocabulary
});

test('timing: a mid-sequence N or X does not shift later chords', () => {
  const runs = observationsToRuns(MIXED);
  // Bare C follows N (8-10) and X (10-12): it must start at its true 12s.
  const last = chipBox(runs[6]);
  assert.equal(runs[6].startSec, 12);
  assert.equal(last.leftPx, 12 * PX_PER_SEC); // 960
  assert.equal(last.leftPx, 960);
  assert.equal(last.widthPx, 160);
  // N and X occupy their real durations.
  assert.equal(chipBox(runs[4]).leftPx, 640);
  assert.equal(chipBox(runs[4]).widthPx, 160);
  assert.equal(chipBox(runs[5]).leftPx, 800);
  assert.equal(chipBox(runs[5]).widthPx, 160);
});

test('timing: a gap between observations is preserved, not packed', () => {
  const runs = observationsToRuns([obs('C:maj', 0, 1), obs('G:maj', 5, 6)]);
  assert.equal(chipBox(runs[1]).leftPx, 400);
  assert.equal(timelineWidthPx(runs), 480);
});

test('N and X are distinguishable from each other and from real chords', () => {
  const runs = observationsToRuns(MIXED);
  assert.equal(runs[4].kind, 'none');
  assert.equal(runs[5].kind, 'unknown');
  assert.equal(runs[0].kind, 'chord');
  const texts = new Set(runs.map(displayText));
  assert.equal(displayText(runs[4]), 'N.C.');
  assert.equal(displayText(runs[5]), '?');
  assert.ok(texts.has('G:7/5'));
  assert.equal(runAriaLabel(runs[4]), 'No chord');
  assert.equal(runAriaLabel(runs[5]), 'Unknown chord');
  assert.notEqual(runAriaLabel(runs[0]), runAriaLabel(runs[4]));
  assert.equal(classifyLabel(''), 'unknown');
});

test('picker: no RangeError from labelAt for any run, including out-of-vocabulary', () => {
  const runs = observationsToRuns(MIXED);
  for (const r of runs) {
    let alts;
    assert.doesNotThrow(() => {
      alts = popoverAlternatives(r.chordClass, 10);
      for (const c of alts) chordLabel(c);
    }, r.label);
    if (r.chordClass === null) assert.deepEqual(alts, []);
  }
  assert.deepEqual(popoverAlternatives(-1), []);
  assert.deepEqual(popoverAlternatives(null), []);
  assert.deepEqual(popoverAlternatives(undefined), []);
});

test('buildChordEdit: tolerates a run with no class index', () => {
  const edit = buildChordEdit({ startFrame: 1, endFrame: 2, chordClass: null }, 5, () => 1);
  assert.equal(edit.originalCls, null);
});

// ---- completed-job tri-state rendering (what the user sees) -----------------
test('completedJobStatus loading: LOADING pill + loading message, no timeline', () => {
  const s = completedJobStatus({ status: 'loading' });
  assert.equal(s.pill, 'LOADING');
  assert.match(s.message, /Loading chords/);
  assert.equal(s.showTimeline, false);
});

test('completedJobStatus ready with chords: JOB pill, timeline, no message', () => {
  const s = completedJobStatus({
    status: 'ready',
    observations: [{ startSec: 0, endSec: 2, label: 'C:maj', confidence: 1 }],
  });
  assert.deepEqual(s, { pill: 'JOB', message: null, showTimeline: true });
});

test('completedJobStatus ready with zero chords: says so instead of an empty box', () => {
  const s = completedJobStatus({ status: 'ready', observations: [] });
  assert.equal(s.pill, 'JOB');
  assert.match(s.message, /No chords were detected/);
  assert.equal(s.showTimeline, false);
});

test('completedJobStatus unavailable-too-long: tells the user the 5 minute limit', () => {
  const s = completedJobStatus({ status: 'unavailable', reason: 'too_long' });
  assert.equal(s.pill, 'UNAVAILABLE');
  assert.match(s.message, /up to 5 minutes/);
  assert.equal(s.showTimeline, false);
});

test('completedJobStatus unavailable-provider-failed: says detection failed, never LOADING', () => {
  const s = completedJobStatus({ status: 'unavailable', reason: 'provider_failed' });
  assert.equal(s.pill, 'UNAVAILABLE');
  assert.match(s.message, /failed/);
});

test('unavailableMessage: every reason has distinct non-empty copy; unknown does not guess a cause', () => {
  const reasons = ['too_long', 'too_short', 'provider_failed', 'not_attempted', 'load_failed', 'unknown'];
  const msgs = reasons.map(unavailableMessage);
  assert.equal(new Set(msgs).size, reasons.length);
  for (const m of msgs) assert.ok(m.length > 10);
  assert.doesNotMatch(unavailableMessage('unknown'), /too long/i);
});

// ---------------- FIX 1: alternatives for the full vocabulary ----------------
const labelsOf = (a) => a.map((x) => x.label);

test('chordAlternatives: non-empty for a slash chord, an extended chord and a bare triad', () => {
  for (const l of ['G:7/5', 'A:min/b3', 'F:maj9', 'E:dim', 'C:sus4', 'C', 'C:maj', 'D:min6']) {
    const alts = chordAlternatives(l);
    assert.ok(alts.length >= 8, `${l}: ${alts.length}`);
    assert.ok(alts.length <= 12, l);
    assert.equal(new Set(labelsOf(alts)).size, alts.length, `${l} has duplicates`);
    assert.ok(!labelsOf(alts).includes(l), `${l} offered itself`);
  }
});

test('chordAlternatives: slash chord offers root position first-class, and vice versa', () => {
  assert.ok(labelsOf(chordAlternatives('G:7/5')).includes('G:7'));
  assert.ok(labelsOf(chordAlternatives('A:min/b3')).includes('A:min'));
  const root = labelsOf(chordAlternatives('C:maj'));
  assert.ok(root.includes('C:maj/3') && root.includes('C:maj/5'));
});

test('chordAlternatives: neighbours lead; "C" and "C:maj" count as the same chord', () => {
  const alts = chordAlternatives('G:7', { prevLabel: 'C:maj', nextLabel: 'C' });
  assert.deepEqual(labelsOf(alts).slice(0, 1), ['C:maj']); // next 'C' deduped against prev
  assert.equal(labelsOf(alts).filter((l) => l === 'C' || l === 'C:maj').length, 1);
  // A neighbour equal to the current chord is not offered.
  assert.ok(!labelsOf(chordAlternatives('G:7', { prevLabel: 'G:7' })).slice(0, 1).includes('G:7'));
});

test('chordAlternatives: N and X are offered, N->X and X->N, never themselves', () => {
  const c = labelsOf(chordAlternatives('C:maj'));
  assert.ok(c.includes('N') && c.includes('X'));
  const n = labelsOf(chordAlternatives('N', { prevLabel: 'C:maj', nextLabel: 'G:7' }));
  assert.ok(!n.includes('N') && n.includes('X') && n.includes('C:maj') && n.includes('G:7'));
  const x = labelsOf(chordAlternatives('X'));
  assert.ok(x.includes('N') && !x.includes('X'));
});

test('chordAlternatives: never throws, never empty, on hostile input', () => {
  for (const l of ['', 'X', 'N', 'Z:foo', 'C:weird/99', 'H', ' ', 'C#:maj/b9', null, undefined, 42]) {
    let a;
    assert.doesNotThrow(() => { a = chordAlternatives(l, { prevLabel: undefined, nextLabel: 'garbage' }, 10); }, String(l));
    assert.ok(a.length >= 1, String(l));
  }
  assert.doesNotThrow(() => chordAlternatives('C:maj', {}, -3));
  assert.doesNotThrow(() => chordAlternatives('C:maj', {}, NaN));
});

test('chordAlternatives: every offered label is Harte-valid for the collector; cls is null or a real index', () => {
  const HARTE = /^(N|X|[A-G](#|b)?(:[a-z0-9]+)?(\/[b#]*(1[0-3]|[1-9]))?)$/;
  for (const r of observationsToRuns(MIXED)) {
    for (const a of chordAlternatives(r.label)) {
      assert.match(a.label, HARTE);
      assert.ok(a.cls === null || (Number.isInteger(a.cls) && a.cls >= 0 && a.cls < 60), a.label);
      assert.doesNotThrow(() => chordLabel(a.cls ?? 0));
    }
  }
});

test('chordAlternatives: cls matches the flat-60 index for legacy labels (D:min = 5)', () => {
  const a = chordAlternatives('C:maj').find((x) => x.label === 'C:min');
  assert.equal(a.cls, 1);
  assert.equal(chordAlternatives('G:7/5').find((x) => x.label === 'G:7').cls, 7 * 5 + 2);
});

test('buildChordEdit persisted shape is unchanged; label edit is a separate additive payload', () => {
  const run = { chordClass: null, startFrame: 3, endFrame: 9, startSec: 0.3, endSec: 0.9, label: 'G:7/5' };
  assert.deepEqual(Object.keys(buildChordEdit(run, 7, () => 1)).sort(),
    ['endFrame', 'newCls', 'originalCls', 'startFrame', 'timestampMs']);
  assert.deepEqual(buildChordLabelEdit(run, 'G:7', () => 5), {
    startFrame: 3, endFrame: 9, startSec: 0.3, endSec: 0.9,
    originalLabel: 'G:7/5', newLabel: 'G:7', timestampMs: 5,
  });
});

// ---------------- FIX 2: zoom, ruler, wrapped layout ----------------
test('zoom: positions scale proportionally with px/sec', () => {
  const runs = observationsToRuns(MIXED);
  const a = chipBox(runs[3], 10);
  const b = chipBox(runs[3], 40);
  assert.equal(b.leftPx / a.leftPx, 4);
  assert.equal(b.widthPx / a.widthPx, 4);
  assert.equal(timelineWidthPx(runs, 40), 4 * timelineWidthPx(runs, 10));
});

test('timing: mid-sequence N/X does not shift later chords at two zoom levels (left = startSec x pxPerSec)', () => {
  const runs = observationsToRuns(MIXED);
  for (const pps of [7.5, 33, MAX_PX_PER_SEC]) {
    assert.equal(chipBox(runs[6], pps).leftPx, 12 * pps);
    assert.equal(chipBox(runs[6], pps).widthPx, 2 * pps);
    assert.equal(chipBox(runs[4], pps).leftPx, 8 * pps);
    assert.equal(chipBox(runs[5], pps).leftPx, 10 * pps);
  }
});

test('zoom: fit-to-width fills the width, is capped at 80, and is the minimum', () => {
  assert.equal(fitPxPerSec(240, 888), 3.7);
  assert.equal(fitPxPerSec(6, 888), MAX_PX_PER_SEC); // short/live: never above max
  assert.equal(fitPxPerSec(0, 888), MAX_PX_PER_SEC);
  assert.equal(fitPxPerSec(240, 0), MAX_PX_PER_SEC);
  assert.equal(clampPxPerSec(1, 3.7), 3.7);
  assert.equal(clampPxPerSec(500, 3.7), 80);
  assert.equal(clampPxPerSec(NaN, 3.7), 3.7);
  assert.equal(clampPxPerSec(10, 100), 80); // min above max collapses to max
  assert.equal(timelineWidthPx([{ endSec: 240 }], fitPxPerSec(240, 888)), 888);
});

test('zoom slider mapping round-trips and hits both ends', () => {
  assert.equal(ppsToSlider(3.7, 3.7), 0);
  assert.ok(Math.abs(ppsToSlider(80, 3.7) - 1) < 1e-9);
  for (const t of [0, 0.25, 0.5, 1]) assert.ok(Math.abs(ppsToSlider(sliderToPps(t, 3.7), 3.7) - t) < 1e-9);
  assert.equal(sliderToPps(5, 3.7), 80);
  assert.equal(ppsToSlider(10, 80, 80), 0);
});

test('ruler: marks are never closer than the minimum spacing at any zoom, start at 0:00, labelled m:ss', () => {
  for (const pps of [1.3, 3.7, 10, 40, 80]) {
    const ticks = rulerTicks(240, pps);
    assert.equal(ticks[0].label, '0:00');
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].leftPx - ticks[i - 1].leftPx >= 64 - 1e-9, `pps ${pps}`);
    assert.ok(ticks.length <= 240 / 1 + 1);
  }
  assert.equal(rulerTicks(240, 3.7)[1].label, '0:30');
  assert.equal(rulerTicks(240, 80)[1].label, '0:01');
  assert.deepEqual(rulerTicks(0, 10), []);
  assert.equal(formatTime(125.9), '2:05');
});

test('wrapped layout: time-proportional per row, splits runs across rows, nothing lost or shifted', () => {
  const runs = observationsToRuns(MIXED); // 0..14s
  const rows = layoutRows(runs, 8, 40);
  assert.equal(rows.length, 2);
  // C bare at 12-14s lands in row 1 at (12-8)*40.
  const seg = rows[1].segments.find((s) => s.runIndex === 6);
  assert.equal(seg.leftPx, 160);
  assert.equal(seg.widthPx, 80);
  assert.equal(seg.continued, false);
  // F:maj9 (6-8) stays in row 0; N (8-10) starts row 1 at 0.
  assert.ok(rows[0].segments.some((s) => s.runIndex === 3));
  assert.equal(rows[1].segments.find((s) => s.runIndex === 4).leftPx, 0);
  // A run crossing a boundary is split, and total width is conserved.
  const split = layoutRows([{ startSec: 6, endSec: 10 }], 8, 10);
  assert.equal(split[0].segments[0].widthPx, 20);
  assert.equal(split[1].segments[0].widthPx, 20);
  assert.equal(split[1].segments[0].continued, true);
  assert.deepEqual(layoutRows([], 8, 10), []);
  assert.deepEqual(layoutRows(runs, 0, 10), []);
  assert.equal(durationSec(runs), 14);
});

test('chipDensity: slivers degrade to ticks instead of overlapping; wide chips stay full', () => {
  assert.equal(chipDensity(80), 'full');
  assert.equal(chipDensity(20), 'tight');
  assert.equal(chipDensity(6), 'tick');
});
