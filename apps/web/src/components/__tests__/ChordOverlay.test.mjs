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
  popoverAlternatives,
} from '../ChordOverlay.helpers.ts';

test('buildChordEdit: carries startFrame, endFrame, original + new class, and timestamp', () => {
  const run = { cls: 3, startFrame: 10, endFrame: 20 };
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
  const edit = buildChordEdit({ cls: 1, startFrame: 0, endFrame: 1 }, 2);
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
