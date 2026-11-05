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
  classifyLabel,
  displayText,
  observationsToRuns,
  popoverAlternatives,
  runAriaLabel,
  timelineWidthPx,
  PX_PER_SEC,
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
