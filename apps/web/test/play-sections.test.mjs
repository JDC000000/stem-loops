// Section looping (Story 4.5): deriveSections() and the SectionLoop control.
//
// sections.ts is pure and imported directly (strip-types). There is NO DOM
// harness in this repo (no jsdom / testing-library), so SectionLoop.tsx is
// transpiled with the TypeScript compiler (as test/helpers/render-login-form.mjs
// does) and exercised two ways: renderToStaticMarkup for what the user sees, and
// by calling the component function and invoking the onClick/onKeyDown props it
// returns. That proves the handlers emit the right regions; it is NOT a browser
// test (no real focus, click or CSS), and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  deriveSections, sanitizeRegions, sameRegion, formatTime, nameRegions, normalizeLabel,
  NO_RUN, tapSection, longPressSection, toggleRunLoop, runRegion, runFromRegion, runName, runReadout,
  stripLegend, placeInSong,
} from '../src/lib/play/sections.ts';
import { withDom } from './helpers/dom.mjs';

// ─── fixtures: the shape of a real production job ───────────────────────────
// 60 loops, 6 stems, bpm 82.5, C major, track 142.6 s. One 4-bar loop is
// 4 * 4 * 60 / 82.5 = 11.636 s, so the song is 12 positional segments. Each stem
// carries 10 of the 12 (2 dropped, different per stem), and `numeric` columns
// arrive from node-pg as strings.
const BPM = 82.5;
const TRACK_SEC = 142.6;
const LOOP_SEC = (4 * 4 * 60) / BPM;
const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const SEG_LABELS = [
  'intro', 'verse', 'verse', 'chorus', 'chorus', 'verse',
  'verse', 'chorus', 'chorus', 'bridge', 'outro', 'outro',
];
// Expected musical sections, as segment index ranges [from, toExclusive).
const EXPECTED = [
  ['intro', 0, 1], ['verse', 1, 3], ['chorus', 3, 5], ['verse', 5, 7],
  ['chorus', 7, 9], ['bridge', 9, 10], ['outro', 10, 12],
];
const at = (i) => Math.round(i * LOOP_SEC * 1000) / 1000;

function loopRow(stem, seg, over = {}) {
  return {
    id: `${stem}-${seg}`, job_id: 'job-1', stem,
    section_label: SEG_LABELS[seg], energy_class: 'mid',
    start_sec: String(i2s(seg)), end_sec: String(i2s(seg + 1)),
    start_bar: seg * 4, bar_count: 4, bpm: '82.5', musical_key: 'C major',
    r2_key: `job-1/${stem}/${seg}.wav`, filename: `${stem}_${seg}.wav`, ...over,
  };
}
function i2s(i) { return i * LOOP_SEC; } // full precision, as the DB would hold it

function realJob() {
  const rows = [];
  STEMS.forEach((stem, k) => {
    for (let seg = 0; seg < 12; seg++) {
      if (seg === k || seg === k + 6) continue; // this stem lost 2 segments
      rows.push(loopRow(stem, seg));
    }
  });
  return rows;
}

const expectedRegions = () => EXPECTED.map(([label, a, b]) => ({ label, startSec: at(a), endSec: at(b) }));
const shape = (rs) => rs.map((r) => ({ label: r.label, startSec: r.startSec, endSec: r.endSec }));
const row = (label, s, e) => ({ section_label: label, start_sec: s, end_sec: e });

test('fixture really is 60 loops across 6 stems on a 142.6 s track', () => {
  const rows = realJob();
  assert.equal(rows.length, 60);
  assert.equal(new Set(rows.map((r) => r.stem)).size, 6);
  assert.ok(12 * LOOP_SEC < TRACK_SEC);
  assert.equal(typeof rows[0].start_sec, 'string'); // pg numeric -> string
});

// ─── R5 / R6: six stems collapse to one set of musical sections ─────────────
test('six stems x 10 loops collapse to the 7 musical sections, not 60 rows', () => {
  const out = deriveSections(realJob(), { durationSec: TRACK_SEC });
  assert.deepEqual(shape(out), expectedRegions());
});

test('result does not depend on row order (DB returns ORDER BY stem, start_sec)', () => {
  const rows = realJob();
  const reversed = [...rows].reverse();
  const shuffled = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1) * ((a.id.length % 3) - 1 || 1));
  assert.deepEqual(deriveSections(reversed), deriveSections(rows));
  assert.deepEqual(deriveSections(shuffled), deriveSections(rows));
});

test('a single stem alone yields the same sections wherever it has coverage', () => {
  const drums = realJob().filter((r) => r.stem === 'drums'); // lost segments 0 and 6
  const out = deriveSections(drums);
  assert.equal(out[0].label, 'verse'); // intro (seg 0) is missing for this stem
  assert.ok(out.length >= 5);
});

// ─── R6: two choruses are two regions ───────────────────────────────────────
test('two separate choruses stay two regions, with the verse between them untouched', () => {
  const out = deriveSections(realJob());
  const choruses = out.filter((r) => r.label === 'chorus');
  assert.equal(choruses.length, 2);
  assert.ok(choruses[0].endSec < choruses[1].startSec);
  const between = out.filter((r) => r.startSec >= choruses[0].endSec && r.endSec <= choruses[1].startSec);
  assert.equal(between.length, 1);
  assert.equal(between[0].label, 'verse');
});

test('consecutive same-label loops form ONE region (chorus is a section, not four loops)', () => {
  const out = deriveSections([row('chorus', 0, 10), row('chorus', 10, 20), row('chorus', 20, 30), row('chorus', 30, 40)]);
  assert.deepEqual(shape(out), [{ label: 'chorus', startSec: 0, endSec: 40 }]);
});

test('same label with a real gap between is two regions, even with nothing in the gap', () => {
  const out = deriveSections([row('chorus', 0, 10), row('chorus', 20, 30)]);
  assert.equal(out.length, 2);
});

test('same label separated by a different label is two regions', () => {
  const out = deriveSections([row('chorus', 0, 10), row('verse', 10, 20), row('chorus', 20, 30)]);
  assert.deepEqual(out.map((r) => r.label), ['chorus', 'verse', 'chorus']);
});

// ─── R1: labels ─────────────────────────────────────────────────────────────
test('null, undefined, empty, blank and non-string labels are ignored, not thrown on', () => {
  const rows = [
    row(null, 0, 10), row(undefined, 0, 10), row('', 0, 10), row('   ', 0, 10), row(42, 0, 10),
    row('verse', 10, 20),
  ];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'verse', startSec: 10, endSec: 20 }]);
});

test('a job with no section labels at all returns [] cleanly', () => {
  const rows = realJob().map((r) => ({ ...r, section_label: null }));
  assert.deepEqual(deriveSections(rows), []);
  assert.deepEqual(deriveSections(realJob().map((r) => ({ ...r, section_label: '' }))), []);
});

test('labels differing only by case or whitespace are the same section', () => {
  const out = deriveSections([row('Chorus', 0, 10), row(' chorus ', 10, 20), row('CHORUS', 20, 30), row('chor\tus'.replace('\t', ''), 30, 40)]);
  assert.deepEqual(shape(out), [{ label: 'chorus', startSec: 0, endSec: 40 }]);
  assert.equal(normalizeLabel('  Pre   Chorus '), 'pre chorus');
  assert.deepEqual(deriveSections([row('Pre  Chorus', 0, 5), row('pre chorus', 5, 10)]).length, 1);
});

test('60 identically-labelled rows are one region', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row('chorus', (i % 6) * 0 + 0, 23.272));
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 23.272 }]);
  const tiled = Array.from({ length: 60 }, (_, i) => row('verse', i * 2, i * 2 + 2));
  assert.deepEqual(shape(deriveSections(tiled)), [{ label: 'verse', startSec: 0, endSec: 120 }]);
});

// ─── empty / degenerate input ───────────────────────────────────────────────
test('empty, null and non-array input return []', () => {
  assert.deepEqual(deriveSections([]), []);
  assert.deepEqual(deriveSections(null), []);
  assert.deepEqual(deriveSections(undefined), []);
  assert.deepEqual(deriveSections('nope'), []);
  assert.deepEqual(deriveSections({ length: 3 }), []);
});

test('a single loop is a single region', () => {
  assert.deepEqual(shape(deriveSections([row('intro', 0, 11.636)])), [{ label: 'intro', startSec: 0, endSec: 11.636 }]);
});

test('null / non-object rows inside the array are skipped', () => {
  assert.deepEqual(deriveSections([null, undefined, 7, 'x', row('verse', 0, 5)]).length, 1);
});

// ─── R2 / R3: bad times ─────────────────────────────────────────────────────
test('rows with end <= start, NaN, Infinity, or missing times never produce a region', () => {
  const rows = [
    row('verse', 10, 10), row('verse', 20, 10), row('verse', NaN, 5), row('verse', 0, Infinity),
    row('verse', null, 5), row('verse', 0, undefined), row('verse', 'abc', 'def'), row('verse', '', ''),
  ];
  assert.deepEqual(deriveSections(rows), []);
});

test('a backwards row cannot lend phantom coverage to the rows around it', () => {
  const rows = [row('verse', 20, 10), row('verse', 25, 12), row('chorus', 0, 30)];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 30 }]);
});

test('numeric strings from pg are coerced; blank string is not 0', () => {
  assert.deepEqual(shape(deriveSections([row('verse', '11.636', '23.272')])), [{ label: 'verse', startSec: 11.636, endSec: 23.272 }]);
  assert.deepEqual(deriveSections([row('verse', '', '5')]), []);
});

test('a region longer than the track is clamped to it; one starting past the end is dropped', () => {
  const out = deriveSections([row('outro', 130, 500), row('bridge', 200, 300)], { durationSec: TRACK_SEC });
  assert.deepEqual(shape(out), [{ label: 'outro', startSec: 130, endSec: TRACK_SEC }]);
  assert.ok(out.every((r) => r.endSec <= TRACK_SEC));
});

test('without a duration nothing is clamped; a nonsense duration is ignored', () => {
  assert.equal(deriveSections([row('outro', 130, 500)])[0].endSec, 500);
  for (const d of [0, -5, NaN, Infinity]) assert.equal(deriveSections([row('outro', 130, 500)], { durationSec: d })[0].endSec, 500);
});

test('negative start is clamped to 0', () => {
  assert.deepEqual(shape(deriveSections([row('intro', -3, 8)])), [{ label: 'intro', startSec: 0, endSec: 8 }]);
  assert.deepEqual(deriveSections([row('intro', -8, -3)]), []);
});

// ─── R4: float noise ────────────────────────────────────────────────────────
test('boundaries that differ by float noise are one boundary, not a sliver region', () => {
  const out = deriveSections([row('verse', 0, 11.636), row('verse', 11.6360004, 23.272), row('chorus', 23.2719996, 34.908)]);
  assert.deepEqual(out.map((r) => r.label), ['verse', 'chorus']);
  assert.equal(out[0].endSec, out[1].startSec);
});

test('stems that disagree on a boundary by <50 ms still give clean, abutting regions', () => {
  const out = deriveSections([
    row('verse', 0, 11.636), row('verse', 0.01, 11.64), row('chorus', 11.62, 23.27), row('chorus', 11.65, 23.3),
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.endSec - r.startSec > 10));
});

test('a boundary gap of more than 50 ms is real and keeps two regions', () => {
  assert.equal(deriveSections([row('verse', 0, 10), row('verse', 10.2, 20)]).length, 2);
});

// ─── R5: overlap resolution ─────────────────────────────────────────────────
test('stems that disagree on a label: the majority wins over the dissenter', () => {
  const rows = [
    ...['drums', 'bass', 'guitar', 'keys', 'vocals'].map(() => row('chorus', 0, 20)),
    row('verse', 0, 20),
  ];
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'chorus', startSec: 0, endSec: 20 }]);
});

test('a dissenting stem on only half the span flips only that half', () => {
  const rows = [row('verse', 0, 20), row('verse', 0, 20), row('chorus', 10, 20), row('chorus', 10, 20), row('chorus', 10, 20)];
  assert.deepEqual(shape(deriveSections(rows)), [
    { label: 'verse', startSec: 0, endSec: 10 },
    { label: 'chorus', startSec: 10, endSec: 20 },
  ]);
});

test('an exact tie is resolved deterministically (alphabetical), independent of row order', () => {
  const a = deriveSections([row('verse', 0, 10), row('chorus', 0, 10)]);
  const b = deriveSections([row('chorus', 0, 10), row('verse', 0, 10)]);
  assert.deepEqual(a, b);
  assert.equal(a[0].label, 'chorus');
});

test('a tie keeps the label already running rather than flickering', () => {
  const rows = [row('verse', 0, 20), row('chorus', 10, 20)]; // 1 vs 1 on [10,20)
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'verse', startSec: 0, endSec: 20 }]);
});

test('overlapping rows with the same label merge into one region', () => {
  assert.deepEqual(shape(deriveSections([row('verse', 0, 15), row('verse', 10, 25)])), [{ label: 'verse', startSec: 0, endSec: 25 }]);
});

// ─── R7: output invariants ──────────────────────────────────────────────────
function assertWellFormed(out) {
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i].startSec) && Number.isFinite(out[i].endSec));
    assert.ok(out[i].endSec > out[i].startSec, `region ${i} has end <= start`);
    assert.ok(out[i].startSec >= 0);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].endSec, `region ${i} overlaps the previous`);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].startSec, 'not sorted by startSec');
  }
}

test('output is sorted by startSec with no overlaps (real job)', () => {
  assertWellFormed(deriveSections(realJob(), { durationSec: TRACK_SEC }));
});

test('output stays sorted/non-overlapping under adversarial random input', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const labels = ['intro', 'Verse', ' verse', 'chorus', 'bridge', 'outro', '', null];
  for (let t = 0; t < 200; t++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => {
      const s = rnd() * 150 - 5;
      return row(labels[Math.floor(rnd() * labels.length)], s, s + rnd() * 40 - 3);
    });
    assertWellFormed(deriveSections(rows, { durationSec: 142.6 }));
  }
});

test('deriveSections does not mutate its input', () => {
  const rows = realJob();
  const before = JSON.stringify(rows);
  deriveSections(rows);
  assert.equal(JSON.stringify(rows), before);
});

// ─── helpers the component relies on ────────────────────────────────────────
test('sanitizeRegions drops end<=start, NaN and negative starts; clamps; sorts; de-dupes', () => {
  const out = sanitizeRegions([
    { startSec: 30, endSec: 40, label: 'b' }, { startSec: 5, endSec: 5 }, { startSec: 9, endSec: 3 },
    { startSec: NaN, endSec: 3 }, { startSec: -1, endSec: 3 }, { startSec: 0, endSec: 10, label: 'a' },
    { startSec: 0.004, endSec: 10.004, label: 'dup' }, { startSec: 140, endSec: 900, label: 'long' },
    { startSec: 200, endSec: 300, label: 'past' }, null,
  ], TRACK_SEC);
  assert.deepEqual(out.map((r) => r.label), ['a', 'b', 'long']);
  assert.equal(out[2].endSec, TRACK_SEC);
  assert.deepEqual(sanitizeRegions(null), []);
  assert.deepEqual(sanitizeRegions('x'), []);
});

test('sanitizeRegions without a duration still rejects zero-length and backwards regions', () => {
  assert.deepEqual(sanitizeRegions([{ startSec: 5, endSec: 5 }, { startSec: 9, endSec: 3 }]), []);
  assert.equal(sanitizeRegions([{ startSec: 5, endSec: 5.001 }]).length, 1);
});

test('a loop shorter than the 50 ms snap window cannot create or erase a region', () => {
  assert.deepEqual(deriveSections([row('verse', 10, 10.02)]), []);
  assert.deepEqual(shape(deriveSections([row('verse', 0, 20), row('chorus', 10, 10.02)])), [{ label: 'verse', startSec: 0, endSec: 20 }]);
});

test('sameRegion compares spans with tolerance and ignores labels; null is never same', () => {
  assert.ok(sameRegion({ startSec: 1, endSec: 2, label: 'a' }, { startSec: 1.005, endSec: 2, label: 'b' }));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, { startSec: 1.5, endSec: 2 }));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, { startSec: 1, endSec: 2.5 }));
  assert.ok(!sameRegion(null, null));
  assert.ok(!sameRegion({ startSec: 1, endSec: 2 }, null));
});

// ─── P2.1: runs of sections — EVERY row of the design table ───────────────
// (DESIGN-PROPOSAL v1.4, P2.1; the mockup's pickSection is the same function.)
const run = (lo, hi, on = true) => ({ run: { lo, hi }, on });

test('P2.1 row 1 — no loop · tap chip X -> loop [X]', () => {
  assert.deepEqual(tapSection(NO_RUN, 3), { state: run(3, 3), extended: false });
});

test('P2.1 row 2 — run [X] (one chip) · tap X -> clear', () => {
  assert.deepEqual(tapSection(run(3, 3), 3), { state: NO_RUN, extended: false });
});

test('P2.1 row 3 — run [i..j] · tap OUTSIDE, either side -> extend to [min(i,X)..max(j,X)]', () => {
  assert.deepEqual(tapSection(run(2, 3), 5), { state: run(2, 5), extended: true }, 'after');
  assert.deepEqual(tapSection(run(2, 3), 0), { state: run(0, 3), extended: true }, 'before');
  assert.deepEqual(tapSection(run(2, 2), 3), { state: run(2, 3), extended: true }, 'a single chip extends too');
  assert.deepEqual(tapSection(run(2, 2), 1), { state: run(1, 2), extended: true });
});

test('P2.1 row 4 — run [i..j], 2+ chips · tap INSIDE -> shrink to that chip', () => {
  for (const i of [2, 3, 4]) assert.deepEqual(tapSection(run(2, 4), i), { state: run(i, i), extended: false }, `chip ${i}`);
});

test('P2.1 row 5 — long-press any chip -> loop only this', () => {
  assert.deepEqual(longPressSection(NO_RUN, 4), run(4, 4));
  assert.deepEqual(longPressSection(run(0, 6), 2), run(2, 2), 'inside a run');
  assert.deepEqual(longPressSection(run(0, 1), 5), run(5, 5), 'outside a run: no extend');
  assert.deepEqual(longPressSection(run(1, 2, false), 2), run(2, 2), 'loop off: on again, alone');
});

test('P2.1 row 6 — loop button, loop on -> off, the run is remembered', () => {
  assert.deepEqual(toggleRunLoop(run(1, 3)), run(1, 3, false));
});

test('P2.1 row 7 — loop button, loop off with a run remembered -> back on', () => {
  assert.deepEqual(toggleRunLoop(run(1, 3, false)), run(1, 3));
});

test('P2.1 row 8 — loop button, loop off and nothing remembered -> no change (disabled)', () => {
  assert.deepEqual(toggleRunLoop(NO_RUN), NO_RUN);
});

test('P2.1 — with the loop off, tapping a REMEMBERED chip re-loops it (alone); outside extends and turns it on', () => {
  assert.deepEqual(tapSection(run(1, 3, false), 2), { state: run(2, 2), extended: false });
  assert.deepEqual(tapSection(run(2, 2, false), 2), { state: run(2, 2), extended: false }, 'a remembered single chip loops, it does not clear');
  assert.deepEqual(tapSection(run(1, 2, false), 4), { state: run(1, 4), extended: true });
});

test('P2.1 — a bad index changes nothing', () => {
  for (const i of [-1, 1.5, NaN]) {
    assert.deepEqual(tapSection(run(1, 2), i).state, run(1, 2));
    assert.deepEqual(longPressSection(run(1, 2), i), run(1, 2));
  }
});

test('P2.1 — a run is ONE continuous span for the engine, gaps between sections included', () => {
  const secs = [
    { startSec: 0, endSec: 10 }, { startSec: 10, endSec: 20 }, { startSec: 22, endSec: 30 }, { startSec: 30, endSec: 40 },
  ];
  assert.deepEqual(runRegion(secs, { lo: 1, hi: 2 }), { startSec: 10, endSec: 30 }, 'the 20-22 gap is inside');
  assert.deepEqual(runRegion(secs, { lo: 0, hi: 0 }), { startSec: 0, endSec: 10 });
  assert.equal(runRegion(secs, null), null);
  assert.equal(runRegion(secs, { lo: 2, hi: 9 }), null);
  assert.deepEqual(runFromRegion(secs, { startSec: 10, endSec: 30 }), { lo: 1, hi: 2 });
  assert.deepEqual(runFromRegion(secs, { startSec: 10.005, endSec: 29.995 }), { lo: 1, hi: 2 }, 'engine rounding');
  assert.equal(runFromRegion(secs, { startSec: 12, endSec: 30 }), null, 'a custom range is not a run');
  assert.equal(runFromRegion(secs, null), null);
});

test('P2.1 — the readout, the strip legend and the run name say the state in words', () => {
  const names = ['Intro', 'Verse 1', 'Chorus 1'];
  const secs = [{ startSec: 0, endSec: 9 }, { startSec: 9, endSec: 47 }, { startSec: 47, endSec: 66 }];
  assert.equal(runName(names, { lo: 1, hi: 2 }), 'Verse 1 \u2192 Chorus 1');
  assert.equal(runName(names, { lo: 1, hi: 2 }, true), 'Verse 1 to Chorus 1');
  assert.equal(runName(names, { lo: 2, hi: 2 }), 'Chorus 1');
  assert.equal(runReadout(names, secs, run(1, 2)), 'Looping Verse 1 \u2192 Chorus 1 \u00b7 0:09\u20131:06');
  assert.equal(runReadout(names, secs, run(1, 2, false)), 'Loop off');
  assert.equal(runReadout(names, secs, NO_RUN), '');
  assert.equal(stripLegend(names, NO_RUN), 'Sections. No loop.');
  assert.equal(stripLegend(names, run(1, 2)), 'Sections. Looping Verse 1 to Chorus 1');
  assert.equal(stripLegend(names, run(1, 2, false)), 'Sections. Loop off, Verse 1 to Chorus 1 remembered');
});

test('placeInSong: the no-chords stage knows the section, bar and beat (bars from the section start)', () => {
  const secs = [{ startSec: 0, endSec: 8 }, { startSec: 8, endSec: 24 }];
  const grid = { beatSec: 0.5, anchorSec: 0, measured: true }; // 2 s bars
  assert.deepEqual(placeInSong(secs, grid, 13.1), { section: 1, bar: 3, bars: 8, beat: 3 });
  assert.deepEqual(placeInSong(secs, grid, 0), { section: 0, bar: 1, bars: 4, beat: 1 });
  assert.deepEqual(placeInSong(secs, null, 13), { section: 1, bar: null, bars: null, beat: null }, 'no tempo, no bars');
  assert.deepEqual(placeInSong(secs, grid, 99), { section: -1, bar: null, bars: null, beat: null });
  assert.deepEqual(placeInSong(secs, grid, null), { section: 0, bar: 1, bars: 4, beat: 1 });
});

test('formatTime renders m:ss and survives bad input', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(142.6), '2:22');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-4), '0:00');
});

test('nameRegions numbers repeated labels and leaves unique ones plain', () => {
  const names = nameRegions(deriveSections(realJob())).map((n) => n.name);
  assert.deepEqual(names, ['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro']);
  assert.deepEqual(nameRegions([{ startSec: 0, endSec: 1 }]).map((n) => n.name), ['Section']);
});

// ─── the component: the section strip ───────────────────────────────────────
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const toJs = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

let loaded;
async function loadComponent() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'section-loop-'));
  writeFileSync(join(dir, 'sections.mjs'), toJs(readFileSync(join(WEB, 'src/lib/play/sections.ts'), 'utf8')));
  // CSS modules: class name = key, so markup assertions read naturally.
  writeFileSync(join(dir, 'styles.mjs'), 'export default new Proxy({}, { get: (_, k) => String(k) });');
  const js = toJs(readFileSync(join(WEB, 'src/components/play/SectionLoop.tsx'), 'utf8'))
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, "from './sections.mjs'")
    .replace(/from ['"]\.\/SectionLoop\.module\.css['"]/g, "from './styles.mjs'");
  writeFileSync(join(dir, 'SectionLoop.mjs'), js);
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const mod = await import(pathToFileURL(join(dir, 'SectionLoop.mjs')).href);
  loaded = { mod, React, render: (p) => renderToStaticMarkup(React.createElement(mod.SectionLoop, p)) };
  return loaded;
}

const NAMES = nameRegions(deriveSections(realJob(), { durationSec: TRACK_SEC })).map((n) => n.name);
const noop = () => {};

test('strip: one real <button> per section in a fieldset whose legend names the run; aria-pressed on each', async () => {
  const { render } = await loadComponent();
  const html = render({ names: NAMES, state: NO_RUN, onTap: noop, onLongPress: noop });
  assert.match(html, /^<fieldset/);
  assert.match(html, /<legend class="srOnly">Sections\. No loop\.<\/legend>/);
  assert.equal((html.match(/<button/g) || []).length, NAMES.length);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, NAMES.length);
  assert.ok(!html.includes('aria-pressed="true"'));
  assert.ok(html.includes('Chorus 1') && html.includes('Chorus 2'));
  assert.doesNotMatch(html, /aria-live/, 'no live region in the strip');
});

test('strip: a looping run presses EVERY chip in it; a remembered run presses none but marks them', async () => {
  const { render } = await loadComponent();
  const on = render({ names: NAMES, state: { run: { lo: 1, hi: 2 }, on: true }, onTap: noop, onLongPress: noop });
  assert.equal((on.match(/aria-pressed="true"/g) || []).length, 2);
  assert.match(on, /Sections\. Looping Verse 1 to Chorus 1/);
  const off = render({ names: NAMES, state: { run: { lo: 1, hi: 2 }, on: false }, onTap: noop, onLongPress: noop });
  assert.equal((off.match(/aria-pressed="true"/g) || []).length, 0);
  assert.equal((off.match(/data-run="remembered"/g) || []).length, 2);
  assert.match(off, /Loop off, Verse 1 to Chorus 1 remembered/);
});

test('strip: the one-time hint is the copy P2.1 specifies, shown only when asked', async () => {
  const { render, mod } = await loadComponent();
  assert.equal(mod.RUN_HINT, 'Looping these — tap one to loop it alone.');
  const st = { run: { lo: 1, hi: 2 }, on: true };
  assert.ok(render({ names: NAMES, state: st, onTap: noop, onLongPress: noop, hint: true }).includes(mod.RUN_HINT));
  assert.ok(!render({ names: NAMES, state: st, onTap: noop, onLongPress: noop }).includes(mod.RUN_HINT));
});

test('strip: no sections renders nothing', async () => {
  const { render } = await loadComponent();
  assert.equal(render({ names: [], state: NO_RUN, onTap: noop, onLongPress: noop }), '');
});

test('strip (DOM): a click, Enter or Space is a TAP on that chip index', async () => {
  const { mod, React } = await loadComponent();
  await withDom(async (dom) => {
    const taps = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: noop }));
    const chips = dom.findAll('button');
    await dom.act(() => chips[3].click());
    assert.deepEqual(taps, [3]);
    await dom.unmountAll();
  });
});

/** A click as a pointer produces it (detail 1); `el.click()` is a keyboard-like click (detail 0). */
const pointerClick = (dom, el) => dom.act(() => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));

test('strip (DOM): long-press 500 ms = loop only this, and the POINTER click after the release is SWALLOWED', async () => {
  const { mod, React } = await loadComponent();
  assert.equal(mod.LONG_PRESS_MS, 500);
  await withDom(async (dom) => {
    const taps = [];
    const longs = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: (i) => longs.push(i) }));
    const chip = dom.findAll('button')[2];
    await dom.pointer('pointerdown', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(450);
    assert.deepEqual(longs, [], 'not before 500 ms');
    await dom.advance(100);
    assert.deepEqual(longs, [2]);
    await dom.pointer('pointerup', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await pointerClick(dom, chip);
    assert.deepEqual(taps, [], 'the release click must not read as a tap (it would clear the loop)');
    // ...and only that one click: the next is a tap again.
    await pointerClick(dom, chip);
    assert.deepEqual(taps, [2]);
    await dom.unmountAll();
  });
});

test('strip (DOM, review S2): a long-press whose click never comes cannot swallow a later activation', async () => {
  const { mod, React } = await loadComponent();
  assert.ok(mod.SWALLOW_WINDOW_MS > 0 && mod.SWALLOW_WINDOW_MS <= 1000);
  await withDom(async (dom) => {
    const taps = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: noop }));
    const [a, b] = dom.findAll('button');
    // Long-press, finger slides off: no click follows.
    await dom.pointer('pointerdown', a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(550);
    await dom.pointer('pointercancel', a, { pointerType: 'touch' });
    // Keyboard / switch / AT activation right away (a click with detail 0): never eaten.
    await dom.act(() => b.click());
    assert.deepEqual(taps, [1], 'keyboard activation swallowed');
    // A keydown also clears the flag.
    await dom.pointer('pointerdown', a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(550);
    await dom.keydown('Enter', { target: b });
    await pointerClick(dom, b);
    assert.deepEqual(taps, [1, 1], 'a keydown in between must clear the flag');
    // And the flag times out: a pointer click well after the long-press is a tap.
    await dom.pointer('pointerdown', a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(550);
    await dom.advance(mod.SWALLOW_WINDOW_MS + 50);
    await pointerClick(dom, b);
    assert.deepEqual(taps, [1, 1, 1], 'the flag outlived its window');
    await dom.unmountAll();
  });
});

test('strip (DOM): a finger that moves (scrolling the strip) cancels the long-press; a short press is a tap', async () => {
  const { mod, React } = await loadComponent();
  await withDom(async (dom) => {
    const taps = [];
    const longs = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: (i) => longs.push(i) }));
    const chip = dom.findAll('button')[1];
    await dom.pointer('pointerdown', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.pointer('pointermove', chip, { clientX: 40, clientY: 10, pointerType: 'touch' });
    await dom.advance(600);
    assert.deepEqual(longs, [], 'moved past the slop: no long-press');
    await dom.pointer('pointerdown', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(100);
    await dom.pointer('pointerup', chip, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await pointerClick(dom, chip);
    await dom.advance(600);
    assert.deepEqual(longs, []);
    assert.deepEqual(taps, [1]);
    await dom.unmountAll();
  });
});

test('strip (DOM): the context menu (Android long-press) is suppressed on a chip', async () => {
  const { mod, React } = await loadComponent();
  await withDom(async (dom) => {
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: noop, onLongPress: noop }));
    const chip = dom.findAll('button')[0];
    const ev = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await dom.act(() => chip.dispatchEvent(ev));
    assert.equal(ev.defaultPrevented, true);
    await dom.unmountAll();
  });
});

test('strip CSS: no iOS callout or text selection on a chip; 44px tall; selected is neutral', () => {
  const css = readFileSync(join(WEB, 'src/components/play/SectionLoop.module.css'), 'utf8');
  const chip = css.match(/\.chip\s*\{([^}]*)\}/)[1];
  assert.match(chip, /-webkit-touch-callout:\s*none/);
  assert.match(chip, /user-select:\s*none/);
  assert.match(chip, /height:\s*var\(--touch-min, 44px\)/);
  assert.doesNotMatch(css.match(/\.chip\[aria-pressed='true'\]\s*\{([^}]*)\}/)[1], /accent/);
});
