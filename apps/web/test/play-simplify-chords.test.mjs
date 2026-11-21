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
  anchorsOn,
  changesPerMinute,
  chordFamily,
  simplifyChords,
  snapToBeat,
  underHalfSounding,
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
      assert.notEqual(chordFamily(out[i].label), chordFamily(out[i - 1].label), 'neighbours of one root and triad are joined');
    }
    // The song still starts and ends where it did; nothing is invented.
    assert.equal(out[0].startSec, runs[0].startSec);
    assert.equal(out.at(-1).endSec, runs.at(-1).endSec);
    // Every name is one the data had, or the plain triad of a chord the data had.
    const names = new Set(runs.map((r) => r.label));
    const fams = new Set(runs.map((r) => chordFamily(r.label)));
    for (const r of out) assert.ok(names.has(r.label) || fams.has(chordFamily(r.label)), r.label);
    // Honest: every shown chord sounds (same root and triad) for at least half of its span.
    assert.equal(underHalfSounding(runs, out), 0, `${slug}: a shown chord sounds for under half its span`);
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

test('Lucky Ticket in numbers: 56.3 -> 28.7 changes/min with the grid, 29.3 without', () => {
  const { runs, grid, anchors } = demo('lucky-ticket');
  assert.equal(changesPerMinute(runs).toFixed(1), '56.3');
  assert.equal(changesPerMinute(simplifyChords(runs, { grid, anchors })).toFixed(1), '28.7');
  assert.equal(changesPerMinute(simplifyChords(runs, {})).toFixed(1), '29.3');
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
  const want = { 'lucky-ticket': ['56.3', '28.7'], 'im-asking-you': ['48.6', '28.9'], offline: ['61.6', '31.6'] };
  for (const slug of DEMOS) {
    const { runs, grid, anchors } = demo(slug);
    const got = [changesPerMinute(runs).toFixed(1), changesPerMinute(simplifyChords(runs, { grid, anchors })).toFixed(1)];
    assert.deepEqual(got, want[slug], slug);
  }
});

// ── review round 1 (PR #333) ───────────────────────────────────────────────
const B = 0.5; // 120 bpm
const G = { beatSec: B, anchorSec: 0 };
const R = (rows) => rows.map(([s, e, label]) => ({ startSec: s, endSec: e, label }));
const shown = (out) => out.map((r) => [r.label, +r.startSec.toFixed(3), +r.endSec.toFixed(3)]);

test('chordFamily: one root and triad is one chord to a player', () => {
  for (const l of ['C', 'C:maj', 'C:maj7', 'C:7', 'C:9', 'C:maj/3', 'C:6']) assert.equal(chordFamily(l), 'C:maj', l);
  for (const l of ['E:min', 'E:min7', 'E:min(9)', 'E:min/b3']) assert.equal(chordFamily(l), 'E:min', l);
  assert.equal(chordFamily('B:hdim7'), 'B:dim');
  assert.equal(chordFamily('D:sus4'), 'D:sus4');
  assert.equal(chordFamily('D:sus2'), 'D:sus2');
  assert.notEqual(chordFamily('E'), chordFamily('E:min'), 'major and minor are different chords');
  assert.equal(chordFamily('N'), 'N');
});

test('same root and triad join FIRST, named as the plain triad unless one spelling holds more than half', () => {
  // C 2 beats + Cmaj7 2 beats: neither holds more than half -> "C".
  assert.deepEqual(shown(simplifyChords(R([[0, 1, 'C'], [1, 2, 'C:maj7'], [2, 4, 'G']]), { grid: G })), [['C', 0, 2], ['G', 2, 4]]);
  // Em7 3 beats + Em 1 beat: Em7 holds 75% -> "Em7" stays.
  assert.deepEqual(shown(simplifyChords(R([[0, 1.5, 'E:min7'], [1.5, 2, 'E:min'], [2, 4, 'A']]), { grid: G })), [['E:min7', 0, 2], ['A', 2, 4]]);
  // Cmaj7 2 beats then C 2 beats: still neither over half -> "C", whichever came first.
  assert.deepEqual(shown(simplifyChords(R([[0, 1, 'C:maj7'], [1, 2, 'C'], [2, 4, 'G']]), { grid: G })), [['C', 0, 2], ['G', 2, 4]]);
  // A sub-beat Cmaj7 inside C is no change at all.
  assert.deepEqual(shown(simplifyChords(R([[0, 2, 'C'], [2, 2.2, 'C:maj7'], [2.2, 4, 'C']]), { grid: G })), [['C', 0, 4]]);
  // E and Em are NOT joined.
  assert.equal(simplifyChords(R([[0, 2, 'E'], [2, 4, 'E:min']]), { grid: G }).length, 2);
});

test('M-1 snowball guard: a merge that would leave the chord sounding under half its span is refused', () => {
  // A B C D E (each under a beat) then F: F may take them only while F still
  // sounds for at least half of what it shows (here 2.25 of 4 s).
  const raw = R([[0, 0.45, 'A'], [0.45, 0.85, 'B'], [0.85, 1.2, 'C'], [1.2, 1.5, 'D'], [1.5, 1.75, 'E'], [1.75, 4, 'F']]);
  const out = simplifyChords(raw, { grid: G });
  assert.equal(underHalfSounding(raw, out), 0, JSON.stringify(shown(out)));
  for (const r of out) assert.ok(r.endSec - r.startSec >= B - 1e-9);
  // Longer run of short chords: F (1 s) cannot take 3 s of other chords; the
  // short ones are merged among themselves instead of all being painted "F".
  const raw2 = R([[0, 0.45, 'A'], [0.45, 0.9, 'B'], [0.9, 1.35, 'A'], [1.35, 1.8, 'B'], [1.8, 2.25, 'A'], [2.25, 2.7, 'B'], [2.7, 3.7, 'F']]);
  const out2 = simplifyChords(raw2, { grid: G });
  assert.equal(underHalfSounding(raw2, out2), 0, JSON.stringify(shown(out2)));
  const f = out2.find((r) => r.label === 'F');
  assert.ok(f.startSec >= 2.5 - 1e-9, `F painted from ${f.startSec}, it sounds from 2.7: ${JSON.stringify(shown(out2))}`);
});

test('a real chord over "no chord": a short G between a long N and C joins C (C starts on the change)', () => {
  const out = simplifyChords(R([[0, 3, 'N'], [3, 3.25, 'G'], [3.25, 4.25, 'C']]), { grid: G });
  assert.deepEqual(shown(out), [['N', 0, 3], ['C', 3, 4.25]]);
});

test('equal neighbours: the short chord joins the EARLIER one (the chord being held)', () => {
  // No grid: 0.5 s floor, nothing snapped. A and B both 1 s; D (0.2 s) goes to A.
  const out = simplifyChords(R([[0, 1, 'A'], [1, 1.25, 'D'], [1.25, 2.25, 'B']]), {});
  assert.deepEqual(shown(out), [['A', 0, 1.25], ['B', 1.25, 2.25]]);
});

test('a snap that leaves a sliver under a beat is merged away (on-grid section re-anchor)', () => {
  // The section start 10.04 is 0.08 beat off the grid (accepted, <= 0.1). D
  // (0.51 s, a beat) snaps to [10.0, 10.04): a 0.04 s sliver, merged again.
  const raw = R([[0, 9.76, 'A'], [9.76, 10.27, 'D'], [10.27, 14, 'G']]);
  const out = simplifyChords(raw, { grid: G, anchors: [10.04] });
  for (const r of out) assert.ok(r.endSec - r.startSec >= B * 0.999, JSON.stringify(shown(out)));
  assert.deepEqual(out.map((r) => r.label), ['A', 'G']);
});

test('H-3: a section start OFF the beat grid (e.g. 0 s, PR #330) is not an anchor; on-grid ones are', () => {
  const grid = { beatSec: 0.588, anchorSec: 0.298 };
  const on = 0.298 + 0.588 * 16;
  assert.deepEqual(anchorsOn(grid, [0, on + 0.588 * 0.3, on]), [on], '0 s (0.49 beat off) and 0.3 beat off are dropped');
  // On every demo, adding a 0 s section start changes nothing.
  for (const slug of DEMOS) {
    const { runs, grid: g, anchors } = demo(slug);
    assert.deepEqual(simplifyChords(runs, { grid: g, anchors: [0, ...anchors] }), simplifyChords(runs, { grid: g, anchors }), slug);
    for (const a of anchorsOn(g, [0, ...anchors])) {
      const off = (a - g.anchorSec) / g.beatSec;
      assert.ok(Math.abs(off - Math.round(off)) <= 0.1, `${slug}: anchor ${a} off the grid`);
    }
  }
  // An off-grid start would have pulled the first section half a beat: it is ignored.
  const raw = R([[0, 1.1, 'C'], [1.1, 2.3, 'G'], [2.3, 4, 'F']]);
  assert.deepEqual(simplifyChords(raw, { grid: G, anchors: [0.25] }), simplifyChords(raw, { grid: G }));
});

test('changes per minute and honesty, all three demos (Simple, beat grid): 0 shown chords under half sounding', () => {
  for (const slug of DEMOS) {
    const { runs, grid, anchors } = demo(slug);
    const out = simplifyChords(runs, { grid, anchors });
    assert.equal(underHalfSounding(runs, out), 0, slug);
    assert.equal(underHalfSounding(runs, simplifyChords(runs, {})), 0, `${slug} no grid`);
  }
});
