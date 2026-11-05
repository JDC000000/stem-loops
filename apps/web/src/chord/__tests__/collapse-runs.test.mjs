// Run-length-encoder for chord-class sequences — PR-Y1.sec-T1.
//
// collapseRuns is the bridge between Viterbi's per-frame class indices and
// the overlay timeline chips. Half-open intervals ([startFrame, endFrame))
// are the project convention; frameSec = plan.hop / plan.sr at inference
// time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseRuns } from '../smoother.ts';
import { chordLabel } from '../alphabet.ts';

// A realistic frameSec for the pinned CQT plan (hop=2048, sr=22050).
const FRAME_SEC = 2048 / 22050;

test('collapseRuns: empty input returns empty output', () => {
  assert.deepEqual(collapseRuns([], FRAME_SEC), []);
});

test('collapseRuns: all-same chord → single run spanning the input', () => {
  const classes = [5, 5, 5, 5];
  const runs = collapseRuns(classes, FRAME_SEC);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], {
    startFrame: 0,
    endFrame: 4,
    startSec: 0,
    endSec: 4 * FRAME_SEC,
    chordClass: 5,
    label: chordLabel(5),
  });
});

test('collapseRuns: three distinct chords → three runs with correct spans', () => {
  const classes = [0, 0, 7, 7, 7, 12];
  const runs = collapseRuns(classes, FRAME_SEC);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0], {
    startFrame: 0,
    endFrame: 2,
    startSec: 0,
    endSec: 2 * FRAME_SEC,
    chordClass: 0,
    label: chordLabel(0),
  });
  assert.deepEqual(runs[1], {
    startFrame: 2,
    endFrame: 5,
    startSec: 2 * FRAME_SEC,
    endSec: 5 * FRAME_SEC,
    chordClass: 7,
    label: chordLabel(7),
  });
  assert.deepEqual(runs[2], {
    startFrame: 5,
    endFrame: 6,
    startSec: 5 * FRAME_SEC,
    endSec: 6 * FRAME_SEC,
    chordClass: 12,
    label: chordLabel(12),
  });
});

test('collapseRuns: startSec / endSec are frame * frameSec', () => {
  const runs = collapseRuns([0, 0, 1, 1, 1], FRAME_SEC);
  // Half-open convention: boundary frame goes to the next run.
  assert.equal(runs[0].startFrame, 0);
  assert.equal(runs[0].endFrame, 2);
  assert.equal(runs[0].startSec, 0);
  assert.equal(runs[0].endSec, 2 * FRAME_SEC);
  assert.equal(runs[1].startFrame, 2);
  assert.equal(runs[1].endFrame, 5);
  assert.equal(runs[1].startSec, 2 * FRAME_SEC);
  assert.equal(runs[1].endSec, 5 * FRAME_SEC);
});

test('collapseRuns: label matches chordLabel(chordClass) for every run', () => {
  // Hit several points of the 60-label alphabet.
  const classes = [0, 0, 1, 15, 15, 45, 59];
  const runs = collapseRuns(classes, FRAME_SEC);
  for (const run of runs) {
    assert.equal(run.label, chordLabel(run.chordClass));
  }
});

test('collapseRuns: single-frame alternations produce one run per frame', () => {
  const runs = collapseRuns([0, 1, 0, 1], FRAME_SEC);
  assert.equal(runs.length, 4);
  for (let i = 0; i < runs.length; i++) {
    assert.equal(runs[i].startFrame, i);
    assert.equal(runs[i].endFrame, i + 1);
    assert.equal(runs[i].chordClass, i % 2);
  }
});

test('collapseRuns: accepts Uint16Array (Viterbi output type)', () => {
  // Viterbi returns Uint16Array; the signature must accept both.
  const classes = new Uint16Array([3, 3, 9, 9]);
  const runs = collapseRuns(classes, FRAME_SEC);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].chordClass, 3);
  assert.equal(runs[1].chordClass, 9);
});

test('collapseRuns: frameSec = 0 produces zero-duration runs (no crash)', () => {
  // Degenerate but should not throw — overlay could call this before plan is
  // loaded in a race; the UI tolerates runs it can't render.
  const runs = collapseRuns([2, 2, 5], 0);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].startSec, 0);
  assert.equal(runs[0].endSec, 0);
});
