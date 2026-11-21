// "Simple" chords (Phase A, D6): src/lib/play/simplify-chords.ts.
// Measured on the three public demo songs (test/fixtures/demo-chords/*.json:
// the real play.chords.json segments plus the job's BPM and section rows, as
// served by GET /api/jobs/<id> and /play-chords on 2026-11-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_CHORD_SEC_NO_GRID,
  changesPerMinute,
  simplifyChords,
  snapToBeat,
} from '../src/lib/play/simplify-chords.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const demo = (slug) => {
  const f = JSON.parse(readFileSync(join(HERE, 'fixtures/demo-chords', `${slug}.json`), 'utf8'));
  const runs = f.segments.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label }));
  const anchors = f.sections.map((s) => s.start_sec);
  const beatSec = 60 / f.bpm;
  return { f, runs, anchors, beatSec, grid: { beatSec, anchorSec: Math.min(...anchors) } };
};
const span = (r) => r.endSec - r.startSec;
const DEMOS = ['lucky-ticket', 'im-asking-you', 'offline'];

test('Lucky Ticket raw data is what the review measured: 201 changes in 3:33, 87 under one beat', () => {
  const { runs, beatSec, f } = demo('lucky-ticket');
  assert.equal(f.bpm, 102);
  assert.equal(runs.length, 201);
  assert.equal(runs.filter((r) => span(r) < beatSec).length, 87);
  assert.ok(Math.abs(runs.at(-1).endSec - 213.24) < 0.01);
});

for (const slug of DEMOS) {
  test(`${slug}: Simple leaves no chord under one beat, every change on a beat, and far fewer changes`, () => {
    const { runs, grid, anchors, beatSec } = demo(slug);
    const before = changesPerMinute(runs);
    const out = simplifyChords(runs, { grid, anchors });
    const after = changesPerMinute(out);
    for (const r of out) assert.ok(span(r) >= beatSec * 0.999, `${r.label} ${span(r).toFixed(3)}s < 1 beat`);
    for (let i = 1; i < out.length; i++) {
      const t = out[i].startSec;
      assert.ok(Math.abs(snapToBeat(t, grid, anchors) - t) < 1e-6, `change at ${t} is off the beat`);
      assert.ok(out[i].startSec >= out[i - 1].endSec - 1e-9, 'in order, no overlap');
      assert.notEqual(out[i].label, out[i - 1].label, 'neighbours with one name are joined');
    }
    // The song still starts and ends where it did; nothing is invented.
    assert.equal(out[0].startSec, runs[0].startSec);
    assert.equal(out.at(-1).endSec, runs.at(-1).endSec);
    const names = new Set(runs.map((r) => r.label));
    for (const r of out) assert.ok(names.has(r.label));
    // At least 30% fewer changes per minute on every demo.
    assert.ok(after <= before * 0.7, `${slug}: ${before.toFixed(1)} -> ${after.toFixed(1)} changes/min`);
    if (process.env.SIMPLE_LOG) console.log(`${slug}: ${runs.length} -> ${out.length} chords, ${before.toFixed(1)} -> ${after.toFixed(1)} changes/min`);
  });

  test(`${slug}: with no beat grid, chords under ${MIN_CHORD_SEC_NO_GRID}s merge and nothing is snapped`, () => {
    const { runs } = demo(slug);
    const out = simplifyChords(runs, { grid: null });
    for (const r of out) assert.ok(span(r) >= MIN_CHORD_SEC_NO_GRID - 1e-9);
    // Every surviving change is one the data had (no snapping without a grid).
    const starts = new Set(runs.map((r) => r.startSec));
    for (const r of out) assert.ok(starts.has(r.startSec));
    assert.ok(changesPerMinute(out) < changesPerMinute(runs) * 0.75);
  });
}

test('Lucky Ticket in numbers: 56.3 -> 30.4 changes/min with the grid, 31.0 without', () => {
  const { runs, grid, anchors } = demo('lucky-ticket');
  assert.equal(changesPerMinute(runs).toFixed(1), '56.3');
  assert.equal(changesPerMinute(simplifyChords(runs, { grid, anchors })).toFixed(1), '30.4');
  assert.equal(changesPerMinute(simplifyChords(runs, {})).toFixed(1), '31.0');
});

test('the input is never modified (display layer only)', () => {
  const { runs, grid, anchors } = demo('offline');
  const copy = JSON.stringify(runs);
  simplifyChords(runs, { grid, anchors });
  assert.equal(JSON.stringify(runs), copy);
});

test('a short chord goes into the LONGER real neighbour; a short "no chord" never wins over a chord', () => {
  const b = 0.5; // 120 bpm
  const grid = { beatSec: b, anchorSec: 0 };
  const run = (s, e, label) => ({ startSec: s * b, endSec: e * b, label });
  // A (4 beats) · B7 (0.2 beat) · Em (2 beats): B7 joins A, the longer one.
  let out = simplifyChords([run(0, 4, 'A'), run(4, 4.2, 'B:7'), run(4.2, 6.2, 'E:min')], { grid });
  assert.deepEqual(out.map((r) => [r.label, r.startSec / b, r.endSec / b]), [['A', 0, 4], ['E:min', 4, 6.2]]);
  // N (6 beats) · G (0.5) · C (2): G joins C, a chord, although N is longer.
  out = simplifyChords([run(0, 6, 'N'), run(6, 6.5, 'G'), run(6.5, 8.5, 'C')], { grid });
  assert.deepEqual(out.map((r) => r.label), ['N', 'C']);
  // A sliver between two of the same chord: all three become one.
  out = simplifyChords([run(0, 4, 'A'), run(4, 4.3, 'D'), run(4.3, 8, 'A')], { grid });
  assert.deepEqual(out.map((r) => [r.label, r.startSec, r.endSec]), [['A', 0, 4]]);
});

test('changes snap to the nearest beat, re-anchored at each section start', () => {
  const b = 0.5;
  const grid = { beatSec: b, anchorSec: 0.1 };
  assert.equal(snapToBeat(1.38, grid), 1.6);
  assert.equal(snapToBeat(1.32, grid), 1.1);
  // A section starts at 10.3 (a beat by the worker): from there the phase is 0.3.
  assert.ok(Math.abs(snapToBeat(11.25, grid, [10.3]) - 11.3) < 1e-9);
  assert.ok(Math.abs(snapToBeat(9.0, grid, [10.3]) - 9.1) < 1e-9);
});

test('edge cases: empty, one chord, junk and a long gap are handled', () => {
  assert.deepEqual(simplifyChords([]), []);
  assert.deepEqual(simplifyChords([{ startSec: 0, endSec: 0.1, label: 'A' }]), [{ startSec: 0, endSec: 0.1, label: 'A' }]);
  const junk = [{ startSec: NaN, endSec: 1, label: 'A' }, { startSec: 2, endSec: 1, label: 'B' }, { startSec: 0, endSec: 3, label: 'C' }];
  assert.deepEqual(simplifyChords(junk).map((r) => r.label), ['C']);
  // A short chord alone between two long gaps is left as it is (nothing to merge into).
  const gap = [{ startSec: 0, endSec: 2, label: 'A' }, { startSec: 10, endSec: 10.2, label: 'B' }, { startSec: 20, endSec: 22, label: 'C' }];
  assert.deepEqual(simplifyChords(gap).map((r) => r.label), ['A', 'B', 'C']);
  // An unusable grid is ignored (time-based merge instead).
  const out = simplifyChords([{ startSec: 0, endSec: 2, label: 'A' }, { startSec: 2, endSec: 2.3, label: 'B' }, { startSec: 2.3, endSec: 4, label: 'C' }], { grid: { beatSec: 0, anchorSec: 0 } });
  assert.deepEqual(out.map((r) => r.label), ['A', 'C']);
});

test('all three demos, changes per minute before -> after (Simple, beat grid)', () => {
  const want = { 'lucky-ticket': ['56.3', '30.4'], 'im-asking-you': ['48.6', '33.4'], offline: ['61.6', '34.1'] };
  for (const slug of DEMOS) {
    const { runs, grid, anchors } = demo(slug);
    const got = [changesPerMinute(runs).toFixed(1), changesPerMinute(simplifyChords(runs, { grid, anchors })).toFixed(1)];
    assert.deepEqual(got, want[slug], slug);
  }
});
