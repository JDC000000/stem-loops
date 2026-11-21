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
  NO_RUN, tapChip, holdChip, loopHere, sectionAt, restartTarget, runRegion, runFromRegion, runName, runReadout,
  stripLegend, placeInSong, partName, SECTION_TONES, STRIP_HINT, RUN_HINT,
  maxPartSec, splitAtCuts, MAX_PART_BARS, PART_SLACK_BARS, MAX_PART_SEC_NO_BPM, RESTART_GRACE_SEC,
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

// R8: with a known duration the last section runs to the end of the track.
const expectedRegions = (dur) =>
  EXPECTED.map(([label, a, b], i) => ({ label, startSec: at(a), endSec: dur !== undefined && i === EXPECTED.length - 1 ? dur : at(b) }));
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
  assert.deepEqual(shape(out), expectedRegions(TRACK_SEC));
  assert.deepEqual(shape(deriveSections(realJob())), expectedRegions(), 'no duration: the last section keeps its own end');
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

test('R8 + R9 (D2): same label with a gap between is ONE region (the gap is closed, then they merge)', () => {
  // Was "two regions" before 2026-11-21: the worker's rows are 4-bar samples,
  // so a gap is unlabelled song, not silence, and two samples of one label
  // with nothing else between them are one section.
  const out = deriveSections([row('chorus', 0, 10), row('chorus', 20, 30)]);
  assert.deepEqual(shape(out), [{ label: 'chorus', startSec: 0, endSec: 30 }]);
});

// ─── R8 / R9: contiguous sections (design review D2, Jon 2026-11-21) ────────
// The production demo (Lucky Ticket, 3:33): 10 four-bar samples ~21 s apart, so
// 56% of the song was in no section and "Chorus 1" was 1:50-2:00. One stem's
// rows, verbatim from GET /api/jobs/<demo> (2026-11-20).
const DEMO_SEC = 213.24074074074073;
const DEMO_ROWS = [
  ['intro', '0.297928993913276', '9.70969369979563'],
  ['verse', '23.8267863285493', '33.2385510344317'],
  ['verse', '45.0028916590044', '54.4146563648867'],
  ['verse', '66.1777847417369', '75.5895494476193'],
  ['verse', '87.3574396515603', '96.7692043574427'],
  ['chorus', '110.885229433112', '120.296994138995'],
  ['chorus', '132.062515073621', '141.474279779503'],
  ['verse', '153.239189021931', '162.650953727813'],
  ['verse', '174.424504212963', '183.836268918845'],
  ['outro', '195.587009957218', '204.998774663101'],
].map(([l, a, b]) => ({ ...row(l, a, b), bpm: '102' })); // every row carries the job's tempo

test('R8/R9/R10 the demo song: 10 samples become 6 contiguous parts covering 100% of the track, none over 20 bars', () => {
  const covered = (rs) => rs.reduce((n, r) => n + (r.endSec - r.startSec), 0);
  const sampled = DEMO_ROWS.reduce((n, r) => n + (Number(r.end_sec) - Number(r.start_sec)), 0);
  assert.ok(sampled / DEMO_SEC < 0.45, `the rows alone cover ${(100 * sampled / DEMO_SEC).toFixed(1)}%`);
  const out = deriveSections(DEMO_ROWS, { durationSec: DEMO_SEC });
  assert.deepEqual(shape(out), [
    { label: 'intro', startSec: 0, endSec: 23.827 },
    // R9 merged four "verse" samples into 0:23-1:50 (87 s, 37 bars); R10 cuts
    // it back at a sample start into the two most even chunks that fit.
    { label: 'verse', startSec: 23.827, endSec: 66.178 },
    { label: 'verse', startSec: 66.178, endSec: 110.885 },
    { label: 'chorus', startSec: 110.885, endSec: 153.239 },
    { label: 'verse', startSec: 153.239, endSec: 195.587 },
    { label: 'outro', startSec: 195.587, endSec: 213.241 },
  ]);
  const bar = 240 / 102;
  for (const r of out) assert.ok((r.endSec - r.startSec) / bar <= MAX_PART_BARS + PART_SLACK_BARS, `a part of ${((r.endSec - r.startSec) / bar).toFixed(1)} bars`);
  assert.ok(Math.abs(covered(out) - DEMO_SEC) < 0.001, 'every second of the song is in a section');
  for (let i = 1; i < out.length; i++) assert.equal(out[i].startSec, out[i - 1].endSec, `gap before part ${i + 1}`);
  // The chorus is the whole chorus (1:50-2:33, 18 bars), not a 4-bar slice.
  assert.equal(formatTime(out[3].startSec) + '-' + formatTime(out[3].endSec), '1:50-2:33');
});

// ─── R10: the cap (review H1 on #330) ──────────────────────────────────────
test('R10: the cap is 16 bars + one 4-bar loop of slack at the song tempo, 45 s without one', () => {
  assert.equal(MAX_PART_BARS, 16);
  assert.equal(PART_SLACK_BARS, 4);
  assert.ok(Math.abs(maxPartSec(102) - (20 * 4 * 60) / 102) < 1e-9);
  assert.equal(maxPartSec(120), 40);
  for (const b of [null, undefined, NaN, 0, 30, 300]) assert.equal(maxPartSec(b), MAX_PART_SEC_NO_BPM);
  assert.equal(MAX_PART_SEC_NO_BPM, 45);
});

test('R10: splitAtCuts makes the FEWEST chunks that fit, as even as possible, only at the given cuts', () => {
  assert.deepEqual(splitAtCuts(0, 30, [10, 20], 40), [0, 30], 'short enough: untouched');
  assert.deepEqual(splitAtCuts(23.827, 110.885, [0, 23.827, 45.003, 66.178, 87.357, 110.885], 47.06), [23.827, 66.178, 110.885], 'two even chunks, not 45|66');
  assert.deepEqual(splitAtCuts(0, 120, Array.from({ length: 60 }, (_, i) => i * 2), 45), [0, 40, 80, 120]);
  assert.deepEqual(splitAtCuts(0, 200, [150], 45), [0, 150, 200], 'no cut in reach: the next cut is the only choice');
  assert.deepEqual(splitAtCuts(0, 200, [], 45), [0, 200], 'no cut at all: one long part (nowhere to cut)');
});

test('R10: one label for the whole song is no longer one 213 s part', () => {
  const out = deriveSections(DEMO_ROWS.map((r) => ({ ...r, section_label: 'verse' })), { durationSec: DEMO_SEC });
  assert.ok(out.length >= 5, `${out.length} parts`);
  for (const r of out) assert.ok(r.endSec - r.startSec <= maxPartSec(102) + 0.05, `${r.startSec}-${r.endSec}`);
  const cuts = new Set(DEMO_ROWS.map((r) => Math.round(Number(r.start_sec) * 1000) / 1000));
  for (const r of out.slice(1)) assert.ok(cuts.has(r.startSec), `part start ${r.startSec} is a sample start`);
});

test('R10: a 10-minute song gets parts of at most 20 bars (synthetic, 120 bpm, a sample every 20 s)', () => {
  const labels = 'intro verse verse verse chorus chorus verse verse verse verse chorus bridge verse verse verse verse verse chorus chorus chorus verse verse verse verse verse verse chorus chorus verse outro'.split(' ');
  const rows = labels.map((l, i) => ({ ...row(l, i * 20 + 0.5, i * 20 + 8.5), bpm: 120 }));
  const out = deriveSections(rows, { durationSec: 600 });
  assert.equal(out.length, 19);
  assert.ok(Math.max(...out.map((r) => r.endSec - r.startSec)) <= 40 + 1e-9);
  const noBpm = deriveSections(rows.map((r) => ({ ...r, bpm: null })), { durationSec: 600 });
  assert.ok(Math.max(...noBpm.map((r) => r.endSec - r.startSec)) <= 45);
  assert.equal(deriveSections(rows, { durationSec: 600, bpm: 60 }).length < out.length, true, 'an explicit slower tempo allows longer parts');
});

test('R9: same-label samples further apart than 2 samples are NOT merged (unknown music between them)', () => {
  // 10 s samples; 25 s gap (2.5 samples) -> two parts; 15 s gap (1.5 samples) -> one.
  assert.equal(deriveSections([row('verse', 0, 10), row('verse', 35, 45)], { durationSec: 50 }).length, 2);
  assert.equal(deriveSections([row('verse', 0, 10), row('verse', 25, 35)], { durationSec: 40 }).length, 1);
});

test('R8: music before the first sample belongs to the first section; after the last, to the last', () => {
  assert.deepEqual(shape(deriveSections([row('verse', 5, 10), row('chorus', 20, 30)], { durationSec: 40 })), [
    { label: 'verse', startSec: 0, endSec: 20 },
    { label: 'chorus', startSec: 20, endSec: 40 },
  ]);
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
  assert.deepEqual(shape(deriveSections(rows)), [{ label: 'verse', startSec: 0, endSec: 20 }], 'R8: starts at 0');
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
  // R10 (no tempo -> 45 s cap): one 120 s "verse" is cut at sample starts.
  assert.deepEqual(shape(deriveSections(tiled)), [
    { label: 'verse', startSec: 0, endSec: 40 },
    { label: 'verse', startSec: 40, endSec: 80 },
    { label: 'verse', startSec: 80, endSec: 120 },
  ]);
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
  assert.deepEqual(shape(deriveSections([row('verse', '11.636', '23.272')])), [{ label: 'verse', startSec: 0, endSec: 23.272 }]);
  assert.deepEqual(shape(deriveSections([row('intro', '0', '11.636'), row('verse', '11.636', '23.272')])).map((r) => r.startSec), [0, 11.636]);
  assert.deepEqual(deriveSections([row('verse', '', '5')]), []);
});

test('a region longer than the track is clamped to it; one starting past the end is dropped', () => {
  const out = deriveSections([row('outro', 130, 500), row('bridge', 200, 300)], { durationSec: TRACK_SEC });
  // R8: the only section starts at 0; R10: 0-142.6 is over the 45 s cap, so it
  // is cut at the one sample start there is (130).
  assert.deepEqual(shape(out), [{ label: 'outro', startSec: 0, endSec: 130 }, { label: 'outro', startSec: 130, endSec: TRACK_SEC }]);
  assert.ok(out.every((r) => r.endSec <= TRACK_SEC));
});

test('without a duration nothing is clamped; a nonsense duration is ignored', () => {
  assert.equal(deriveSections([row('outro', 130, 500)]).at(-1).endSec, 500);
  for (const d of [0, -5, NaN, Infinity]) assert.equal(deriveSections([row('outro', 130, 500)], { durationSec: d }).at(-1).endSec, 500);
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

test('a boundary gap of more than 50 ms is real: two labels stay two regions, closed up (R8); one label merges (R9)', () => {
  assert.deepEqual(shape(deriveSections([row('verse', 0, 10), row('chorus', 10.2, 20)])), [
    { label: 'verse', startSec: 0, endSec: 10.2 },
    { label: 'chorus', startSec: 10.2, endSec: 20 },
  ]);
  assert.equal(deriveSections([row('verse', 0, 10), row('verse', 10.2, 20)]).length, 1);
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
function assertWellFormed(out, durationSec) {
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i].startSec) && Number.isFinite(out[i].endSec));
    assert.ok(out[i].endSec > out[i].startSec, `region ${i} has end <= start`);
    assert.ok(out[i].startSec >= 0);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].endSec, `region ${i} overlaps the previous`);
    if (i > 0) assert.ok(out[i].startSec >= out[i - 1].startSec, 'not sorted by startSec');
    // R8: contiguous from 0; R9: neighbours never share a label.
    if (i === 0) assert.equal(out[i].startSec, 0, 'the first region starts at 0');
    if (i > 0) assert.equal(out[i].startSec, out[i - 1].endSec, `a gap before region ${i}`);
    // (Neighbours may share a label since R10 splits a long part, or R9 refuses a far merge.)
  }
  if (durationSec !== undefined && out.length > 0) assert.equal(out[out.length - 1].endSec, Math.round(durationSec * 1000) / 1000, 'the last region runs to the end');
}

test('output is sorted by startSec with no overlaps (real job)', () => {
  assertWellFormed(deriveSections(realJob(), { durationSec: TRACK_SEC }), TRACK_SEC);
  assertWellFormed(deriveSections(DEMO_ROWS, { durationSec: DEMO_SEC }), DEMO_SEC);
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
    assertWellFormed(deriveSections(rows, { durationSec: 142.6 }), 142.6);
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

// ─── D4 (Jon 2026-11-21): tap JUMPS, hold LOOPS — EVERY row of the table ───
// (lib/play/sections.ts, the table above tapChip.) This replaces the P2.1
// "tap = loop" rows and the QA C-10 (option b) rows, which pinned what a TAP
// did with the loop off: a tap no longer loops at all. The P2 run model
// (extend / shrink) is unchanged; it moved from the tap to the hold.
const run = (lo, hi, on = true) => ({ run: { lo, hi }, on });

test('D4 tap · no loop -> jump, nothing looped', () => {
  assert.deepEqual(tapChip(NO_RUN, 3), { state: NO_RUN, jump: true });
});

test('D4 tap · looping, a chip OF the run -> loop off (run remembered), no jump', () => {
  assert.deepEqual(tapChip(run(3, 3), 3), { state: run(3, 3, false), jump: false }, 'the single looped chip');
  for (const i of [2, 3, 4]) assert.deepEqual(tapChip(run(2, 4), i), { state: run(2, 4, false), jump: false }, `chip ${i} of a run`);
});

test('D4 tap · looping, a chip OUTSIDE the run -> jump there, the loop goes off (remembered)', () => {
  assert.deepEqual(tapChip(run(2, 3), 5), { state: run(2, 3, false), jump: true });
  assert.deepEqual(tapChip(run(2, 3), 0), { state: run(2, 3, false), jump: true });
});

test('D4 tap · loop off with a run remembered -> jump, the run stays remembered (never extended)', () => {
  // The C-10 repro (loop off on Verse 1, tap Outro used to give Verse 1 -> Outro) cannot recur: a tap never loops.
  assert.deepEqual(tapChip(run(2, 2, false), 5), { state: run(2, 2, false), jump: true });
  assert.deepEqual(tapChip(run(1, 3, false), 2), { state: run(1, 3, false), jump: true }, 'inside the remembered run');
});

test('D4 hold · no loop or loop off -> loop [X] alone', () => {
  assert.deepEqual(holdChip(NO_RUN, 4), { state: run(4, 4), extended: false });
  for (const r of [[0, 0], [0, 6], [2, 4], [5, 5]]) {
    for (let x = 0; x <= 6; x++) assert.deepEqual(holdChip(run(r[0], r[1], false), x), { state: run(x, x), extended: false }, `remembered ${r} hold ${x}`);
  }
});

test('D4 hold · looping [i..j], hold OUTSIDE, either side -> extend to [min(i,X)..max(j,X)] (P2)', () => {
  assert.deepEqual(holdChip(run(2, 3), 5), { state: run(2, 5), extended: true }, 'after');
  assert.deepEqual(holdChip(run(2, 3), 0), { state: run(0, 3), extended: true }, 'before');
  assert.deepEqual(holdChip(run(2, 2), 3), { state: run(2, 3), extended: true }, 'a single chip extends too');
});

test('D4 hold · looping [i..j] (2+ chips), hold INSIDE -> shrink to that chip (P2)', () => {
  for (const i of [2, 3, 4]) assert.deepEqual(holdChip(run(2, 4), i), { state: run(i, i), extended: false }, `chip ${i}`);
});

test('D4 hold · looping [X], hold X again -> no change (it keeps looping, never clears)', () => {
  assert.deepEqual(holdChip(run(4, 4), 4), { state: run(4, 4), extended: false });
});

test('D4 the Loop button: on -> off (remembered); off -> the remembered run if the playhead is in it, else the section under the playhead', () => {
  assert.deepEqual(loopHere(run(1, 3), 2), run(1, 3, false));
  assert.deepEqual(loopHere(run(1, 3, false), 2), run(1, 3), 'playhead inside the remembered run');
  assert.deepEqual(loopHere(run(1, 3, false), 5), run(5, 5), 'playhead elsewhere: loop where I am');
  assert.deepEqual(loopHere(NO_RUN, 4), run(4, 4), 'nothing remembered: loop where I am');
  assert.deepEqual(loopHere(NO_RUN, -1), NO_RUN, 'no section under the playhead: nothing to loop');
  assert.deepEqual(loopHere(run(1, 3, false), -1), run(1, 3), 'no section: the remembered run comes back');
});

test('D4 a full sequence: tap Part 3 (jump), hold it (loop), hold Part 4 (extend), tap Part 4 (stop), Loop button (resume)', () => {
  let s = NO_RUN;
  let t = tapChip(s, 2);
  assert.equal(t.jump, true);
  s = t.state;
  s = holdChip(s, 2).state;
  assert.deepEqual(s, run(2, 2));
  const h = holdChip(s, 3);
  assert.equal(h.extended, true);
  s = h.state;
  t = tapChip(s, 3);
  assert.deepEqual(t, { state: run(2, 3, false), jump: false });
  assert.deepEqual(loopHere(t.state, 3), run(2, 3));
});

test('D4 a bad index changes nothing', () => {
  for (const i of [-1, 1.5, NaN]) {
    assert.deepEqual(tapChip(run(1, 2), i), { state: run(1, 2), jump: false });
    assert.deepEqual(holdChip(run(1, 2), i), { state: run(1, 2), extended: false });
  }
});

test('sectionAt and restartTarget (⟲): the section under the playhead, or the loop start while looping', () => {
  const secs = deriveSections(DEMO_ROWS, { durationSec: DEMO_SEC });
  assert.equal(sectionAt(secs, 0), 0);
  assert.equal(sectionAt(secs, 134), 3, '2:14 is in Part 4 (the old "Chorus 2")');
  assert.equal(sectionAt(secs, 153.239), 4, 'a boundary belongs to the section it starts');
  assert.equal(sectionAt(secs, DEMO_SEC), 5, 'the very end is still the last section');
  assert.equal(sectionAt(secs, null), 0);
  assert.equal(sectionAt([], 10), -1);
  assert.equal(restartTarget(secs, null, 134), 110.885);
  assert.equal(restartTarget(secs, { startSec: 23.827, endSec: 153.239 }, 134), 23.827, 'in a loop: the loop start');
  assert.equal(restartTarget(secs, { startSec: 23.827, endSec: 153.239 }, 24), 23.827, 'in a loop, near its start: still the loop start (never out of the loop)');
  assert.equal(restartTarget(secs, { startSec: 5, endSec: 5 }, 134), 110.885, 'an invalid loop is ignored');
  assert.equal(restartTarget([], null, 50), 0, 'no sections: the top of the song');
});

test('⟲ (review M3): within 1.5 s of a section start it goes to the PREVIOUS section, like "previous track"', () => {
  const secs = deriveSections(DEMO_ROWS, { durationSec: DEMO_SEC });
  assert.equal(RESTART_GRACE_SEC, 1.5);
  assert.equal(restartTarget(secs, null, 110.885), 66.178, 'exactly at Part 4: back to Part 3');
  assert.equal(restartTarget(secs, null, 110.885 + 1.4), 66.178, '1.4 s in: back to Part 3');
  assert.equal(restartTarget(secs, null, 110.885 + 1.6), 110.885, '1.6 s in: the start of Part 4');
  assert.equal(restartTarget(secs, null, 0.5), 0, 'in Part 1 there is nothing before it');
});

test('sectionAt / ⟲ (review L1): past the last section while the duration is unknown, the last section still counts', () => {
  const secs = deriveSections(DEMO_ROWS); // no duration: the last part ends at its own sample (204.999)
  assert.equal(secs.at(-1).endSec, 204.999);
  assert.equal(sectionAt(secs, 210), secs.length - 1);
  assert.equal(restartTarget(secs, null, 210), 195.587, 'not 0:00');
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
  const names = ['Part 1', 'Part 2', 'Part 3'];
  const secs = [{ startSec: 0, endSec: 9 }, { startSec: 9, endSec: 47 }, { startSec: 47, endSec: 66 }];
  assert.equal(runName(names, { lo: 1, hi: 2 }), 'Part 2 \u2192 Part 3');
  assert.equal(runName(names, { lo: 1, hi: 2 }, true), 'Part 2 to Part 3');
  assert.equal(runName(names, { lo: 2, hi: 2 }), 'Part 3');
  assert.equal(runReadout(names, secs, run(1, 2)), 'Looping Part 2 \u2192 Part 3 \u00b7 0:09\u20131:06');
  assert.equal(runReadout(names, secs, run(1, 2, false)), 'Loop off');
  assert.equal(runReadout(names, secs, NO_RUN), '');
  // D4: the group label says how the strip works, then the state.
  assert.equal(stripLegend(names, NO_RUN), 'Sections. Tap to jump, hold or Shift+Enter to loop. No loop.');
  assert.equal(stripLegend(names, run(1, 2)), 'Sections. Tap to jump, hold or Shift+Enter to loop. Looping Part 2 to Part 3.');
  assert.equal(stripLegend(names, run(1, 2, false)), 'Sections. Tap to jump, hold or Shift+Enter to loop. Loop off, Part 2 to Part 3 remembered.');
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

test('nameRegions (D2): neutral "Part N" + start time, never the heuristic label; colours cycle so neighbours differ', () => {
  const named = nameRegions(deriveSections(DEMO_ROWS, { durationSec: DEMO_SEC }));
  assert.deepEqual(named.map((n) => `${n.name} \u00b7 ${n.time}`), ['Part 1 \u00b7 0:00', 'Part 2 \u00b7 0:23', 'Part 3 \u00b7 1:06', 'Part 4 \u00b7 1:50', 'Part 5 \u00b7 2:33', 'Part 6 \u00b7 3:15']);
  assert.deepEqual(named.map((n) => n.tone), [0, 1, 2, 0, 1, 2]);
  const real = nameRegions(deriveSections(realJob())).map((n) => n.name);
  assert.deepEqual(real, ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6', 'Part 7']);
  for (const n of [...named, ...nameRegions(deriveSections(realJob()))]) assert.doesNotMatch(n.name, /chorus|verse|intro|outro|bridge/i);
  for (let i = 1; i < 20; i++) assert.notEqual(i % SECTION_TONES, (i - 1) % SECTION_TONES);
  assert.equal(partName(0), 'Part 1');
  assert.deepEqual(nameRegions([{ startSec: 0, endSec: 1 }]).map((n) => n.name), ['Part 1']);
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
const TIMES = nameRegions(deriveSections(realJob(), { durationSec: TRACK_SEC })).map((n) => n.time);
const TONES = nameRegions(deriveSections(realJob(), { durationSec: TRACK_SEC })).map((n) => n.tone);
const noop = () => {};

test('strip: one real <button> per section in a fieldset whose legend names the run; aria-pressed on each', async () => {
  const { render } = await loadComponent();
  const html = render({ names: NAMES, state: NO_RUN, onTap: noop, onLongPress: noop });
  assert.match(html, /^<fieldset/);
  assert.match(html, /<legend class="srOnly">Sections\. Tap to jump, hold or Shift\+Enter to loop\. No loop\.<\/legend>/);
  assert.equal((html.match(/<button/g) || []).length, NAMES.length);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, NAMES.length);
  assert.equal((html.match(/aria-keyshortcuts="Shift\+Enter"/g) || []).length, NAMES.length);
  assert.ok(!html.includes('aria-pressed="true"'));
  assert.ok(html.includes('Part 3') && !/Chorus|Verse/.test(html), 'neutral names only (D2)');
  assert.doesNotMatch(html, /aria-live/, 'no live region in the strip');
});

test('strip: a looping run presses EVERY chip in it; a remembered run presses none but marks them', async () => {
  const { render } = await loadComponent();
  const on = render({ names: NAMES, state: { run: { lo: 1, hi: 2 }, on: true }, onTap: noop, onLongPress: noop });
  assert.equal((on.match(/aria-pressed="true"/g) || []).length, 2);
  assert.match(on, /Looping Part 2 to Part 3/);
  const off = render({ names: NAMES, state: { run: { lo: 1, hi: 2 }, on: false }, onTap: noop, onLongPress: noop });
  assert.equal((off.match(/aria-pressed="true"/g) || []).length, 0);
  assert.equal((off.match(/data-run="remembered"/g) || []).length, 2);
  assert.match(off, /Loop off, Part 2 to Part 3 remembered/);
});

test('strip: the one-time hints are the D4 / P2.1 copy, shown only when asked', async () => {
  const { render, mod } = await loadComponent();
  assert.equal(mod.STRIP_HINT, 'Tap to jump \u00b7 hold to loop');
  assert.equal(STRIP_HINT, mod.STRIP_HINT);
  assert.equal(mod.RUN_HINT, 'Looping these \u00b7 hold one to loop it alone');
  assert.equal(RUN_HINT, mod.RUN_HINT);
  const st = { run: { lo: 1, hi: 2 }, on: true };
  assert.ok(render({ names: NAMES, state: st, onTap: noop, onLongPress: noop, hint: mod.RUN_HINT }).includes('Looping these'));
  assert.ok(render({ names: NAMES, state: NO_RUN, onTap: noop, onLongPress: noop, hint: mod.STRIP_HINT }).includes('Tap to jump'));
  assert.doesNotMatch(render({ names: NAMES, state: st, onTap: noop, onLongPress: noop }), /section-hint/);
});

test('strip (D2): each chip shows "Part N · m:ss", carries its colour slot, and the current section is aria-current', async () => {
  const { render } = await loadComponent();
  const html = render({ names: NAMES, times: TIMES, tones: TONES, current: 2, state: NO_RUN, onTap: noop, onLongPress: noop });
  const text = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.match(text, /\|Part 3\| · \|0:34\|/);
  assert.deepEqual([...html.matchAll(/data-tone="(\d)"/g)].map((m) => Number(m[1])), TONES);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /data-index="2"[^>]*aria-current="true"/);
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

test('strip (DOM, D4): Shift+Enter is the keyboard long-press (loop); plain Enter is left to the button (a tap)', async () => {
  const { mod, React } = await loadComponent();
  await withDom(async (dom) => {
    const taps = [];
    const longs = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: (i) => longs.push(i) }));
    const chip = dom.findAll('button')[4];
    const shifted = await dom.keydown('Enter', { target: chip, shiftKey: true });
    assert.deepEqual(longs, [4]);
    assert.equal(shifted.defaultPrevented, true, 'Shift+Enter must not also click (jump)');
    await dom.keydown('Enter', { target: chip, shiftKey: true, repeat: true });
    assert.deepEqual(longs, [4], 'a held key repeats nothing');
    const plain = await dom.keydown('Enter', { target: chip });
    assert.equal(plain.defaultPrevented, false, 'plain Enter keeps its native click');
    for (const mod2 of ['ctrlKey', 'metaKey', 'altKey']) await dom.keydown('Enter', { target: chip, shiftKey: true, [mod2]: true });
    assert.deepEqual(longs, [4], 'Shift+Enter with another modifier is not ours');
    assert.deepEqual(taps, []);
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
    assert.deepEqual(taps, [], 'the release click must not read as a tap (it would stop the loop it just started)');
    // ...and only that one click: the next is a tap again.
    await pointerClick(dom, chip);
    assert.deepEqual(taps, [2]);
    await dom.unmountAll();
  });
});

test('strip (DOM, review R1): a LONG hold (2000 ms) still swallows its release click; the window starts at release', async () => {
  const { mod, React } = await loadComponent();
  await withDom(async (dom) => {
    const taps = [];
    const longs = [];
    await dom.mount(React.createElement(mod.SectionLoop, { names: NAMES, state: NO_RUN, onTap: (i) => taps.push(i), onLongPress: (i) => longs.push(i) }));
    const chip = dom.findAll('button')[2];
    for (const pointerType of ['mouse', 'touch']) {
      taps.length = 0;
      await dom.pointer('pointerdown', chip, { clientX: 10, clientY: 10, pointerType });
      await dom.advance(2000); // held well past LONG_PRESS_MS + SWALLOW_WINDOW_MS
      await dom.pointer('pointerup', chip, { clientX: 10, clientY: 10, pointerType });
      await pointerClick(dom, chip);
      assert.deepEqual(taps, [], `${pointerType}: the release click after a 2 s hold undid the long-press`);
      await dom.advance(mod.SWALLOW_WINDOW_MS + 50);
    }
    assert.equal(longs.length, 2);
    assert.ok(2000 > mod.LONG_PRESS_MS + mod.SWALLOW_WINDOW_MS, 'the hold must outlast the old (fire-time) window');
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
    // And the flag times out: a pointer click well after the long-press is RELEASED is a tap.
    await dom.pointer('pointerdown', a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    await dom.advance(550);
    await dom.pointer('pointerup', a, { clientX: 10, clientY: 10, pointerType: 'touch' });
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
  // Selected stays the ONE neutral pressed state: #222 + a 2px white edge.
  assert.match(css.match(/\.chip\[aria-pressed='true'\]\s*\{([^}]*)\}/)[1], /background:\s*var\(--bg-selected\)[^}]*border:\s*2px solid var\(--text-primary\)/);
});

test('strip CSS (D4 item 4, review B1): chips WRAP; 2 rows, 3 at >= 800px tall, 1 below 600px; then the strip scrolls vertically', () => {
  const css = readFileSync(join(WEB, 'src/components/play/SectionLoop.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const list = css.match(/\.list\s*\{([^}]*)\}/)[1];
  assert.match(list, /flex-wrap:\s*wrap/);
  assert.match(list, /--rows:\s*2;/);
  assert.match(list, /max-height:\s*calc\(var\(--rows\) \* var\(--chip-h\) \+ \(var\(--rows\) - 1\) \* var\(--space-2, 8px\) \+ 8px\)/);
  // The bands, exactly: a phone of 800-844px tall must get 3 rows, 600-799px 2, and only below 600px 1.
  const media = [...css.matchAll(/@media\s*\(([^)]*)\)\s*\{\s*\.list\s*\{\s*--rows:\s*(\d)/g)].map((m) => `${m[1].replace(/\s+/g, '')}=${m[2]}`);
  assert.deepEqual(media.sort(), ['max-height:599px=1', 'min-height:800px=3']);
  // Phones up to 430px wide stack the time under the name (4 chips a row at 360-430px).
  assert.match(css, /@media\s*\(max-width:\s*430px\)\s*\{\s*\.label\s*\{[^}]*flex-direction:\s*column/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.doesNotMatch(list, /overflow-x:\s*auto/);
  assert.match(css.match(/\.chip\s*\{([^}]*)\}/)[1], /touch-action:\s*pan-y/);
});
