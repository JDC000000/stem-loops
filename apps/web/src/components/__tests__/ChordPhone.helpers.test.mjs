// Unit tests for the phone chord view's pure helpers (ChordPhone.helpers.ts)
// and the beat-grid reader it relies on (beatGridFromLoops, lib/play/sections.ts).
// The rendered view is gated in real Chromium by
// packages/web-browser-gate/test/chord-phone-view.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { activeRunIndex, observationsToRuns } from '../ChordOverlay.helpers.ts';
import { MIN_TAP_PX } from '../tapTarget.ts';
import {
  BEATS_PER_BAR,
  NAME_MIN_PX,
  showsBarTotal,
  beatInCell,
  beatsUntil,
  buildPhoneModel,
  cellIndexAt,
  downbeatVotes,
  gridFit,
  meterFit,
  layoutLine,
  leadSheetSymbol,
  lineIndexOfCell,
  nameWidth,
  nextChord,
  nearestCellStart,
  nextLineIndex,
  phoneBarLabel,
  phoneSections,
  phoneSlotLabel,
  positionLabel,
} from '../ChordPhone.helpers.ts';
import { beatGridFromLoops } from '../../lib/play/sections.ts';

const FIX = JSON.parse(readFileSync(join(import.meta.dirname, '../../../test/fixtures/play-chords-4m-two-chord-bars.json'), 'utf8'));
const toRuns = (segs) => observationsToRuns(segs.map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, label: s.label, confidence: 1 })));
const RUNS = toRuns(FIX.segments);
const DUR = FIX.duration_sec;
const BEAT = 60 / FIX._fixture.bpm;
const BAR = 4 * BEAT;
const GRID = { beatSec: BEAT, anchorSec: FIX._fixture.anchor_sec, measured: true };
const SECTIONS = FIX._fixture.sections;
const DOWN = FIX._fixture.first_downbeat_sec;
const MODEL = buildPhoneModel(RUNS, GRID, SECTIONS, DUR);
const chord = (label) => ({ kind: label === 'N' ? 'none' : label === 'X' ? 'unknown' : 'chord', label });

/** Synthetic song: `bars` is a list of bars, each a list of [label, beats]. */
function song(bars, { bpm = 100, offset = 0.5, drift = 1, beatsPerBar = 4 } = {}) {
  const beat = 60 / bpm;
  const segs = [];
  let t = offset;
  let b = 0;
  for (const bar of bars) {
    for (const [label, beats] of bar) {
      const s = offset + (b * beat) * drift;
      b += beats;
      segs.push({ start_sec: s, end_sec: offset + (b * beat) * drift, label, confidence: 1 });
      t = segs[segs.length - 1].end_sec;
    }
  }
  void beatsPerBar;
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.label === s.label) last.end_sec = s.end_sec;
    else merged.push({ ...s });
  }
  return { runs: toRuns(merged), dur: t + 0.25, grid: { beatSec: 60 / bpm, anchorSec: offset, measured: true } };
}

// ---------------------------------------------------------------------------
test('leadSheetSymbol: chart spelling with the ♭/♯ glyphs, Harte when unsure', () => {
  const cases = {
    'A:min7': 'Am7', 'G:7/5': 'G7/D', 'Bb:maj': 'B♭', 'C:maj6': 'C6', 'F#:min7': 'F♯m7', 'F:maj7/3': 'Fmaj7/A',
    'C:hdim7': 'Cm7♭5', 'C#:hdim7/5': 'C♯m7♭5/G♯', 'E:sus4/b7': 'Esus4/D', 'C:maj9': 'Cmaj9', 'C:1': 'C', 'C': 'C',
    'Bb:maj/3': 'B♭/D', 'Eb:7/b7': 'E♭7/D♭', 'D:min(9)': 'D:min(9)', 'G:weird': 'G:weird', 'H:maj': 'H:maj', 'C:maj/x': 'C:maj/x',
  };
  for (const [h, want] of Object.entries(cases)) assert.equal(leadSheetSymbol(chord(h)), want, h);
  assert.equal(leadSheetSymbol(chord('N')), 'N.C.');
  assert.equal(leadSheetSymbol(chord('X')), '?');
});

test('phoneSlotLabel names the chord in WORDS ("flat"/"sharp", never a glyph) and says the beats', () => {
  assert.equal(phoneSlotLabel(chord('E:min7'), 2), 'E minor 7, 2 beats — edit');
  assert.equal(phoneSlotLabel(chord('C'), 1), 'C, 1 beat — edit');
  assert.equal(phoneSlotLabel(chord('N'), null), 'No chord — edit');
  assert.equal(phoneSlotLabel(chord('X'), 3.02), 'Unknown chord, 3 beats — edit');
  assert.equal(phoneSlotLabel(chord('G:7'), 1.5), 'G 7, 1.5 beats — edit');
  assert.equal(phoneSlotLabel(chord('C#:hdim7/5'), 2), 'C sharp minor 7 flat 5 over G sharp, 2 beats — edit');
  assert.equal(phoneSlotLabel(chord('Bb:maj'), 2), 'B flat, 2 beats — edit');
  for (const l of ['A:min7', 'C#:hdim7/5', 'Bb:maj', 'Eb:7/b7'])
    assert.doesNotMatch(phoneSlotLabel(chord(l), 2), /[♭♯#]/, l);
});

test('beatGridFromLoops: bpm and earliest start, numeric strings, guards', () => {
  assert.deepEqual(beatGridFromLoops([{ bpm: '96.000', start_sec: '10.4' }, { bpm: 96, start_sec: 0.4 }]), { beatSec: 0.625, anchorSec: 0.4, measured: true });
  assert.equal(beatGridFromLoops([]), null);
  assert.equal(beatGridFromLoops(null), null);
  assert.equal(beatGridFromLoops([{ bpm: null, start_sec: 1 }]), null);
  assert.equal(beatGridFromLoops([{ bpm: 300, start_sec: 1 }]), null);
  assert.equal(beatGridFromLoops([{ bpm: 30, start_sec: 1 }]), null);
  assert.deepEqual(beatGridFromLoops([{ bpm: 120 }]), { beatSec: 0.5, anchorSec: 0, measured: true });
});

test('phoneBarLabel names the bar and its chords in order, in words', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.map((s) => RUNS[s.runIndex].label).join() === 'G:7,Bb:maj');
  const c = MODEL.cells[ci];
  // D2: sections are named neutrally by position; the bridge is the 6th.
  assert.equal(phoneBarLabel(MODEL, RUNS, ci), `Bar ${c.numberInSection} of ${c.countInSection}, Part 6: G 7, B flat`);
  const four = MODEL.cells.findIndex((x) => x.slots.length === 4);
  assert.match(phoneBarLabel(MODEL, RUNS, four), /^Bar \d+ of 8, Part 8: D minor 7, G 7, C sharp minor 7 flat 5 over G sharp, C$/);
  assert.equal(phoneBarLabel(MODEL, RUNS, 99999), '');
});

test('phoneSections: sorted, clamped, named "Part N" like nameRegions (D2: never the label), overlaps dropped', () => {
  const s = phoneSections(
    [
      { startSec: 40, endSec: 60, label: 'chorus' },
      { startSec: 0, endSec: 20, label: ' Verse ' },
      { startSec: 20, endSec: 40, label: 'chorus' },
      { startSec: 30, endSec: 35, label: 'overlap' },
      { startSec: 60, endSec: 999, label: '' },
      { startSec: NaN, endSec: 3, label: 'bad' },
    ],
    100,
  );
  assert.deepEqual(s, [
    { startSec: 0, endSec: 20, name: 'Part 1' },
    { startSec: 20, endSec: 40, name: 'Part 2' },
    { startSec: 40, endSec: 60, name: 'Part 3' },
    { startSec: 60, endSec: 100, name: 'Part 4' },
  ]);
  assert.deepEqual(phoneSections(undefined, 10), []);
});

// ---------------------------------------------------------------------------
test('fixture: bars mode, downbeat found on the second worker beat, every chord shown', () => {
  assert.equal(MODEL.mode, 'bars');
  const votes = downbeatVotes(RUNS, phoneSections(SECTIONS, DUR), GRID, DUR);
  assert.equal(votes.phase, 1, 'bar 1 is planted on the second detected beat');
  assert.equal(gridFit(votes), 'ok');
  // Bars start on the planted downbeats.
  const first = MODEL.cells[0];
  assert.ok(Math.abs(first.startSec - DOWN) < 1e-6, `first bar at ${first.startSec}, want ${DOWN}`);
  for (const c of MODEL.cells) {
    const k = (c.startSec - DOWN) / BAR;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `bar at ${c.startSec} is off the downbeat grid`);
  }
  // Every run except the count-in and tail silence is in some cell.
  const shown = new Set(MODEL.cells.flatMap((c) => c.slots.map((s) => s.runIndex)));
  assert.equal(MODEL.cells.length, FIX._fixture.bars);
  for (let i = 1; i < RUNS.length - 1; i++) assert.ok(shown.has(i), `run ${i} ${RUNS[i].label} is in no cell`);
  // Two-chord bars are split, with beats.
  const split = MODEL.cells.filter((c) => c.slots.length === 2);
  assert.ok(split.length >= 30, `${split.length} split bars`);
  const g7bb = MODEL.cells.find((c) => c.slots.map((s) => RUNS[s.runIndex].label).join() === 'G:7,Bb:maj');
  assert.ok(g7bb, 'the 3+1 bar G7|Bb is one cell');
  assert.deepEqual(g7bb.slots.map((s) => Math.round(s.beats)), [3, 1]);
  const four = MODEL.cells.find((c) => c.slots.length === 4);
  assert.deepEqual(four.slots.map((s) => RUNS[s.runIndex].label), ['D:min7', 'G:7', 'C#:hdim7/5', 'C:maj']);
});

test('fixture: numbering is per section, 1-based, and lines start at sections', () => {
  for (const c of MODEL.cells) {
    assert.ok(c.numberInSection >= 1 && c.numberInSection <= c.countInSection, JSON.stringify(c));
  }
  const counts = MODEL.sections.map((_, i) => MODEL.cells.filter((c) => c.section === i).length);
  assert.deepEqual(counts, [4, 16, 16, 16, 16, 8, 16, 8]);
  for (const l of MODEL.lines) {
    assert.ok(l.cells.length >= 1 && l.cells.length <= BEATS_PER_BAR);
    assert.ok(l.cells.every((ci) => MODEL.cells[ci].section === l.section), 'a line crosses a section');
    const firstInSec = MODEL.cells[l.cells[0]].numberInSection;
    assert.equal((firstInSec - 1) % BEATS_PER_BAR, 0, 'a line does not start at bar 1, 5, 9 ... of its section');
  }
  const chorus2 = MODEL.sections.findIndex((s) => s.name === 'Part 5');
  const c = MODEL.cells.findIndex((x) => x.section === chorus2 && x.numberInSection === 3);
  assert.equal(positionLabel(MODEL, c), 'Part 5 · bar 3/16');
});

test('cellIndexAt / lineIndexOfCell / beatInCell / beatsUntil', () => {
  assert.equal(cellIndexAt(MODEL, 0.2), -1, 'count-in silence is before the first bar');
  assert.equal(cellIndexAt(MODEL, null), -1);
  assert.equal(cellIndexAt(MODEL, DOWN + 0.01), 0);
  const t = DOWN + 37 * BAR + 2.2 * BEAT;
  const ci = cellIndexAt(MODEL, t);
  assert.ok(Math.abs(MODEL.cells[ci].startSec - (DOWN + 37 * BAR)) < 1e-6);
  assert.equal(beatInCell(MODEL.cells[ci], t), 2);
  assert.equal(beatInCell(MODEL.cells[ci], MODEL.cells[ci].startSec), 0);
  assert.equal(beatInCell(MODEL.cells[ci], MODEL.cells[ci].endSec + 5), 3);
  assert.equal(beatsUntil(MODEL.cells[ci], 1.0 * BEAT), 1);
  assert.equal(beatsUntil(MODEL.cells[ci], 1.5 * BEAT), 2);
  assert.equal(beatsUntil(MODEL.cells[ci], 0.01), 1);
  assert.equal(lineIndexOfCell(MODEL, -1), -1);
  assert.equal(MODEL.lines[lineIndexOfCell(MODEL, ci)].cells.includes(ci), true);
  assert.equal(cellIndexAt(MODEL, DUR + 100), MODEL.cells.length - 1);
});

test('nextChord: from the playhead, skips N and repeats, follows the loop, gap-safe', () => {
  // Ordinary: in Em7 of the chorus Em7|Am bar -> Am.
  const em = RUNS.findIndex((r, i) => r.label === 'E:min7' && RUNS[i + 1]?.label === 'A:min');
  const t = RUNS[em].startSec + 0.1;
  const n = nextChord(RUNS, t, em, null);
  assert.equal(RUNS[n.runIndex].label, 'A:min');
  assert.ok(Math.abs(n.inSec - (RUNS[em + 1].startSec - t)) < 1e-9);
  assert.equal(n.wraps, false);
  // In a gap (activeIdx -1): the next chord AFTER the playhead, never run 0.
  const gapRuns = RUNS.filter((_, i) => i < 50 || i > 52);
  const gapT = (RUNS[49].endSec + RUNS[53].startSec) / 2;
  const g = nextChord(gapRuns, gapT, -1, null);
  assert.equal(gapRuns[g.runIndex].startSec, RUNS[53].startSec, 'gap: wrong next chord');
  // Skips "no chord" and a repeat of the chord already sounding.
  const rr = toRuns([
    { start_sec: 0, end_sec: 1, label: 'C:maj' },
    { start_sec: 1, end_sec: 1.5, label: 'N' },
    { start_sec: 1.5, end_sec: 2, label: 'C:maj' },
    { start_sec: 2, end_sec: 3, label: 'G:maj' },
  ]);
  assert.equal(rr[nextChord(rr, 0.5, 0, null).runIndex].label, 'G:maj');
  assert.equal(nextChord(rr, 2.5, 3, null), null, 'nothing after the last chord');
  // Loop: near the loop end the next chord is the loop's first chord.
  const sec = MODEL.sections.find((s) => s.name === 'Part 5');
  const loop = { startSec: sec.startSec, endSec: sec.endSec };
  const late = sec.endSec - 0.3;
  const li = RUNS.findIndex((r) => r.startSec <= late && late < r.endSec);
  const w = nextChord(RUNS, late, li, loop);
  assert.equal(w.wraps, true);
  // What is HEARD at the wrap: the chord at the loop's start (the worker's
  // loop starts one beat before the chorus downbeat, so that is verse 2's C).
  const atStart = RUNS.findIndex((r) => r.startSec <= loop.startSec + 1e-3 && loop.startSec + 1e-3 < r.endSec);
  assert.equal(w.runIndex, atStart, 'the loop must wrap to the chord at its start');
  assert.ok(Math.abs(w.inSec - 0.3) < 1e-9);
  // Outside the loop the loop is ignored.
  assert.equal(nextChord(RUNS, sec.startSec - 5, RUNS.findIndex((r) => r.startSec <= sec.startSec - 5 && sec.startSec - 5 < r.endSec), loop).wraps, false);
  assert.equal(nextChord(RUNS, null, 3, null), null);
});

test('nextLineIndex: following line, or the loop start line at the loop end', () => {
  const sec = MODEL.sections.findIndex((s) => s.name === 'Part 5');
  const lines = MODEL.lines.map((l, i) => i).filter((i) => MODEL.lines[i].section === sec);
  const s = MODEL.sections[sec];
  const loop = { startSec: s.startSec, endSec: s.endSec };
  const lastLine = lines[lines.length - 1];
  assert.equal(nextLineIndex(MODEL, lastLine, null, s.endSec - 0.5), lastLine + 1);
  assert.equal(nextLineIndex(MODEL, lastLine, loop, s.endSec - 0.5), lines[0], 'loop end must page back to the loop start');
  assert.equal(nextLineIndex(MODEL, lines[0], loop, s.startSec + 1), lines[1]);
  assert.equal(nextLineIndex(MODEL, MODEL.lines.length - 1, null, DUR - 1), -1);
  assert.equal(nextLineIndex(MODEL, -1, null, 0), 0);
});

test('nearestCellStart snaps a worker loop edge (a beat before the downbeat) to the bar line', () => {
  const sec = MODEL.sections.find((s) => s.name === 'Part 5');
  const ci = nearestCellStart(MODEL, sec.startSec);
  assert.ok(Math.abs(MODEL.cells[ci].startSec - (sec.startSec + BEAT)) < 1e-6);
  assert.equal(MODEL.cells[ci].numberInSection, 1);
  void activeRunIndex;
});

test('positionLabel: bars, sequence, before the first section', () => {
  const seq = buildPhoneModel(RUNS, null, SECTIONS, DUR);
  const ci = cellIndexAt(seq, 120);
  assert.equal(positionLabel(seq, ci), seq.sections[seq.cells[ci].section].name);
  // Review A (2026-11-20): in sequence mode the heading names the section
  // under the PLAYHEAD, not the one the current chord started in. A chord
  // held across a boundary used to read the previous section.
  const held = buildPhoneModel(
    toRuns([
      { start_sec: 0, end_sec: 8, label: 'C:maj' },
      { start_sec: 8, end_sec: 14, label: 'G:maj' }, // starts in Part 1, held into Part 2
      { start_sec: 14, end_sec: 20, label: 'F:maj' },
    ]),
    null,
    [
      { startSec: 0, endSec: 10, label: 'verse' },
      { startSec: 10, endSec: 20, label: 'chorus' },
    ],
    20,
  );
  assert.equal(held.mode, 'sequence');
  const g = cellIndexAt(held, 12);
  assert.equal(positionLabel(held, g), 'Part 1', 'without the playhead: the section the chord started in');
  assert.equal(positionLabel(held, g, 12), 'Part 2', 'with the playhead: the section being heard');
  assert.equal(positionLabel(held, g, 9), 'Part 1');
  const noSec = buildPhoneModel(RUNS, GRID, [], DUR);
  assert.equal(noSec.mode, 'bars');
  assert.match(positionLabel(noSec, 3), /^Bar 4\/\d+$/);
  assert.equal(positionLabel(MODEL, -1), 'Now');
});

// ---------------------------------------------------------------------------
// When NOT to draw bars
// ---------------------------------------------------------------------------
test('no grid -> sequence: one cell per chord, no beats', () => {
  const m = buildPhoneModel(RUNS, null, SECTIONS, DUR);
  assert.equal(m.mode, 'sequence');
  assert.equal(m.reason, 'no-grid');
  assert.equal(m.cells.length, RUNS.length);
  assert.ok(m.cells.every((c) => c.slots.length === 1 && c.slots[0].beats === null));
  assert.equal(buildPhoneModel(RUNS, { ...GRID, measured: false }, SECTIONS, DUR).mode, 'sequence');
  assert.equal(buildPhoneModel(RUNS, { ...GRID, beatSec: NaN }, SECTIONS, DUR).mode, 'sequence');
});

/** Bars of 3/4 as [label, beats] lists, on a grid whose first beat is the first chord. */
const waltz = (bars, bpm = 96) => song(bars, { bpm });
const WP = ['C:maj', 'A:min', 'F:maj', 'G:7', 'E:min7', 'A:min', 'D:min7', 'G:7'];

test('3/4: an UNAMBIGUOUS 3-beat cycle (changes only on the bar line) draws 3-beat bars on the true downbeats', () => {
  for (const [what, bars] of [
    ['a change every bar', Array.from({ length: 48 }, (_, k) => [[WP[k % 8], 3]])],
    ['a change every 2 bars', Array.from({ length: 32 }, (_, k) => [[WP[k % 8], 6]])],
    ['6/8 counted in eighths (two bars of three)', Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 6]])],
  ]) {
    const w = waltz(bars, what.startsWith('6/8') ? 180 : 96);
    const v = downbeatVotes(w.runs, [], w.grid, w.dur);
    assert.deepEqual(meterFit(v), { reason: 'ok', beatsPerBar: 3 }, what);
    const m = buildPhoneModel(w.runs, w.grid, [], w.dur);
    assert.equal(m.mode, 'bars', what);
    assert.equal(m.beatsPerBar, 3, what);
    const beat = w.grid.beatSec;
    for (const c of m.cells) {
      const k = (c.startSec - 0.5) / (3 * beat);
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `${what}: bar at ${c.startSec} is off the 3/4 downbeats`);
      assert.ok(Math.abs(c.slots.reduce((a, s) => a + s.beats, 0) - 3) < 0.05, `${what}: a bar does not hold 3 beats`);
    }
    const ci = cellIndexAt(m, 0.5 + (3 * 5 + 1.2) * beat);
    assert.equal(beatInCell(m.cells[ci], 0.5 + (3 * 5 + 1.2) * beat, 3), 1);
    // Triple time: no total (3/4 vs 6/8 is unknowable from the data).
    assert.equal(positionLabel(m, ci), `Bar ${m.cells[ci].numberInSection}`);
  }
});

// ---------------------------------------------------------------------------
// No total when unsure (S5 on #281; Jon 2026-11-16). A 3-pulse cycle is 3/4 or
// 6/8-in-eighths at every tempo the grid accepts, so triple time shows "Bar n"
// with no "/N", and the layout stays the 3-beat cells of v3/main (no 6/8 guess).
// ---------------------------------------------------------------------------
const noTotal = (m, runs, what) => {
  m.cells.forEach((c, i) => {
    const p = positionLabel(m, i);
    assert.doesNotMatch(p, /\//, `${what}: position "${p}" shows a total`);
    assert.doesNotMatch(phoneBarLabel(m, runs, i).replace(/:.*$/, ''), / of /, `${what}: bar name shows a total`);
  });
};
for (const bpm of [120, 150, 180]) {
  test(`triple time @${bpm}: 3/4 and 6/8-in-eighths both keep 3-beat cells and show NO bar total`, () => {
    for (const [what, bars, nCells] of [
      ['3/4, a change every bar', Array.from({ length: 48 }, (_, k) => [[WP[k % 8], 3]]), 48],
      ['6/8 in eighths, a change every bar', Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 6]]), 80],
      ['6/8 in eighths, 3+3', Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 3], [WP[(k + 3) % 8], 3]]), 80],
    ]) {
      const w = waltz(bars, bpm);
      const m = buildPhoneModel(w.runs, w.grid, [], w.dur);
      assert.equal(m.mode, 'bars', what);
      assert.equal(m.beatsPerBar, 3, `${what}: no 6/8 guess from tempo`);
      assert.equal(showsBarTotal(m), false);
      assert.equal(m.cells.length, nCells, what);
      const beat = w.grid.beatSec;
      m.cells.forEach((c, i) => {
        assert.ok(Math.abs(c.startSec - (0.5 + 3 * i * beat)) < 1e-6, `${what}: cell ${i + 1} off the 3-beat grid`);
        assert.ok(Math.abs(c.endSec - c.startSec - 3 * beat) < 1e-6, `${what}: cell ${i + 1} is not 3 beats`);
      });
      assert.equal(positionLabel(m, 11), 'Bar 12');
      assert.match(phoneBarLabel(m, w.runs, 11), /^Bar 12: /);
      noTotal(m, w.runs, `${what} @${bpm}`);
    }
  });
}

test('triple time in sections: "Part 1 · bar 3", never "bar 3/N"; 4/4 in sections keeps "bar 3/16"', () => {
  const w = waltz(Array.from({ length: 32 }, (_, k) => [[WP[k % 8], 6]]), 138);
  const beat = w.grid.beatSec;
  const sections = [];
  for (let b = 0; b < 32 * 6; b += 48) sections.push({ startSec: 0.5 + b * beat, endSec: 0.5 + (b + 48) * beat, label: 'verse' });
  const m = buildPhoneModel(w.runs, w.grid, sections, w.dur);
  assert.equal(m.beatsPerBar, 3);
  assert.equal(positionLabel(m, 2), 'Part 1 · bar 3');
  noTotal(m, w.runs, 'sectioned 6/8 @138');
  assert.equal(positionLabel(MODEL, cellIndexAt(MODEL, MODEL.cells.find((c) => c.numberInSection === 3 && MODEL.sections[c.section]?.name === 'Part 5').startSec)), 'Part 5 · bar 3/16');
});

test('4/4 keeps its total: "Bar n/N" with N = the cells drawn', () => {
  const s4 = song(Array.from({ length: 32 }, (_, k) => [[WP[k % 8], 4]]), { bpm: 180 });
  const m = buildPhoneModel(s4.runs, s4.grid, [], s4.dur);
  assert.equal(m.beatsPerBar, 4);
  assert.equal(showsBarTotal(m), true);
  assert.equal(m.cells.length, 32);
  assert.equal(positionLabel(m, 11), 'Bar 12/32');
  assert.match(phoneBarLabel(m, s4.runs, 11), /^Bar 12 of 32: /);
  assert.equal(showsBarTotal({ mode: 'sequence', beatsPerBar: 4 }), false);
});

test('pickups: bar starts land on the downbeats, the pickup is bar 1, labels carry no total', () => {
  // 6/8 in eighths at 180 with a 3-pulse Em pickup, then 40 bars of 6.
  const p68 = waltz([[['E:min', 3]], ...Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 6]])], 180);
  const m68 = buildPhoneModel(p68.runs, p68.grid, [], p68.dur);
  assert.equal(m68.beatsPerBar, 3);
  assert.equal(m68.cells.length, 81);
  const b68 = p68.grid.beatSec;
  m68.cells.forEach((c, i) => assert.ok(Math.abs(c.startSec - (0.5 + 3 * i * b68)) < 1e-6, `6/8 pickup: cell ${i + 1} at ${c.startSec}`));
  assert.equal(positionLabel(m68, 0), 'Bar 1');
  assert.equal(positionLabel(m68, 80), 'Bar 81');
  assert.equal(phoneBarLabel(m68, p68.runs, 0), 'Bar 1: E minor');
  // 3/4 at 96 with a 1-beat pickup: bars start one beat after the first chord.
  const p34 = waltz([[['E:min', 1]], ...Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 3]])], 96);
  const m34 = buildPhoneModel(p34.runs, p34.grid, [], p34.dur);
  assert.equal(m34.beatsPerBar, 3);
  const b34 = p34.grid.beatSec;
  const real = m34.cells.filter((c) => c.startSec >= 0.5 + b34 - 1e-6);
  assert.equal(real.length, 40);
  real.forEach((c, i) => assert.ok(Math.abs(c.startSec - (0.5 + b34 + 3 * i * b34)) < 1e-6, `3/4 pickup: bar at ${c.startSec} off the downbeat`));
  assert.equal(m34.cells.length, 41, 'the pickup is a bar of its own');
  assert.equal(positionLabel(m34, 0), 'Bar 1');
  assert.equal(positionLabel(m34, 40), 'Bar 41');
  noTotal(m34, p34.runs, '3/4 pickup');
});

test('3/4 in worker sections (4-beat lines): the beat count is carried, bars stay on the waltz downbeat', () => {
  const w = waltz(Array.from({ length: 32 }, (_, k) => [[WP[k % 8], 6]]));
  const beat = w.grid.beatSec;
  const sections = [];
  for (let b = 0; b < 32 * 6; b += 16) sections.push({ startSec: 0.5 + b * beat, endSec: 0.5 + (b + 16) * beat, label: 'verse' });
  const m = buildPhoneModel(w.runs, w.grid, sections, w.dur);
  assert.equal(m.mode, 'bars');
  assert.equal(m.beatsPerBar, 3);
  for (const c of m.cells) {
    const k = (c.startSec - 0.5) / (3 * beat);
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `bar at ${c.startSec} is off the waltz downbeat`);
  }
});

test('meter uncertain -> plain list: 12-beat cycles, 3/4 with changes inside the bar (2+1, 1+2, alternating)', () => {
  // The beat data has no explicit downbeats; a change inside a 3/4 bar makes
  // the downbeat ambiguous (review 6: "1+2" was given a wrong downbeat).
  for (const [what, bars] of [
    ['3/4 2+1', Array.from({ length: 40 }, (_, k) => [[WP[k % 8], 2], [WP[(k + 3) % 8], 1]])],
    ['3/4 1+2', Array.from({ length: 41 }, (_, k) => [[WP[k % 8], 1], [WP[(k + 3) % 8], 2]])],
    ['3/4 2+1 every other bar', Array.from({ length: 40 }, (_, k) => (k % 2 ? [[WP[k % 8], 3]] : [[WP[k % 8], 2], [WP[(k + 3) % 8], 1]]))],
    ['3/4 every 4 bars', Array.from({ length: 20 }, (_, k) => [[WP[k % 8], 12]])],
    ['4/4 every 3 bars', Array.from({ length: 20 }, (_, k) => [[WP[k % 8], 12]])],
    ['3/4 alternating 2+1 and 1+2', Array.from({ length: 40 }, (_, k) => (k % 2 ? [[WP[k % 8], 1], [WP[(k + 3) % 8], 2]] : [[WP[k % 8], 2], [WP[(k + 3) % 8], 1]]))],
  ]) {
    const w = waltz(bars);
    const m = buildPhoneModel(w.runs, w.grid, [], w.dur);
    assert.equal(m.mode, 'sequence', `${what} drawn as ${m.mode}/${m.beatsPerBar}`);
    assert.equal(m.reason, 'meter', what);
  }
  // ... while 4/4 (2+2, 1 per bar, 3+1, 3+3+2) keeps its 4-beat bars.
  for (const [what, bar] of [['2+2', [2, 2]], ['1 per bar', [4]], ['3+1', [3, 1]], ['3+3+2 over 2 bars', [3, 3, 2]]]) {
    const len = bar.reduce((a, b) => a + b, 0);
    const bars = Array.from({ length: 64 / (len / 4) }, (_, k) => bar.map((b, j) => [WP[(k * bar.length + j) % 8], b]));
    const w = song(bars, { bpm: 100 });
    const m = buildPhoneModel(w.runs, w.grid, [], w.dur);
    assert.equal(m.mode, 'bars', what);
    assert.equal(m.beatsPerBar, 4, what);
  }
});

test('poor fit (chords not on the beat) -> sequence', () => {
  const segs = [];
  let t = 0.3;
  for (let i = 0; i < 40; i++) {
    const d = 1.13 + ((i * 7) % 5) * 0.37;
    segs.push({ start_sec: t, end_sec: t + d, label: ['C:maj', 'G:maj', 'A:min', 'F:maj'][i % 4] });
    t += d;
  }
  const m = buildPhoneModel(toRuns(segs), { beatSec: 0.5, anchorSec: 0.3, measured: true }, [], t);
  assert.equal(m.mode, 'sequence');
  assert.equal(m.reason, 'poor-fit');
});

test('one chord per beat (no downbeat evidence) -> sequence; too few changes -> sequence', () => {
  const bars = [];
  for (let k = 0; k < 24; k++) bars.push([['A:min7', 1], ['D:7', 1], ['G:maj7', 1], ['C:maj7', 1]]);
  const w = song(bars, { bpm: 120 });
  assert.equal(buildPhoneModel(w.runs, w.grid, [], w.dur).mode, 'sequence');
  const few = song([[['C:maj', 4]], [['G:maj', 4]], [['C:maj', 4]]]);
  assert.equal(buildPhoneModel(few.runs, few.grid, [], few.dur).reason, 'few-changes');
});

test('two chords in EVERY bar -> bars with split cells (half-bar tie is not an odd meter)', () => {
  // Jon's case. Beat 1 and beat 3 get equal votes; the first chord after the
  // silence (on beat 1) settles which is the downbeat.
  const bars = [];
  const prog = [[['C:maj', 2], ['A:min', 2]], [['F:maj', 2], ['G:maj', 2]], [['E:min7', 2], ['A:min7', 2]], [['D:min7', 2], ['G:7', 2]]];
  for (let k = 0; k < 48; k++) bars.push(prog[k % 4]);
  const w = song(bars, { bpm: 92 });
  const votes = downbeatVotes(w.runs, [], w.grid, w.dur);
  assert.equal(votes.halfBarTie, true);
  assert.equal(votes.phase, 0);
  const m = buildPhoneModel(w.runs, w.grid, [], w.dur);
  assert.equal(m.mode, 'bars', `fell back: ${m.reason}`);
  assert.equal(m.cells.length, 48);
  for (const c of m.cells) assert.equal(c.slots.length, 2, 'every bar is one cell holding its two chords');
  assert.equal(w.runs[m.cells[0].slots[0].runIndex].label, 'C:maj');
  assert.equal(w.runs[m.cells[0].slots[1].runIndex].label, 'A:min');
  // Same song starting on the half-bar (a 2-beat pickup): the first chord still decides.
  const pick = song([[['G:7', 2]], ...bars], { bpm: 92 });
  const mp = buildPhoneModel(pick.runs, pick.grid, [], pick.dur);
  assert.equal(mp.mode, 'bars');
});

test('tempo drift is bounded by re-anchoring at each section', () => {
  // The song plays 1% slower than its grid; sections (as the worker snaps
  // them) are on the real bar lines. At 200 s the bar must still hold the
  // chord being heard.
  const bars = [];
  const prog = [[['C:maj', 4]], [['A:min', 2], ['F:maj', 2]], [['G:maj', 4]], [['C:maj', 2], ['G:7', 2]]];
  for (let k = 0; k < 96; k++) bars.push(prog[k % 4]);
  const w = song(bars, { bpm: 100, drift: 1.01 });
  const realBar = 4 * 0.6 * 1.01;
  const sections = [];
  for (let s = 0; s < 96; s += 8) sections.push({ startSec: 0.5 + s * realBar, endSec: 0.5 + (s + 8) * realBar, label: s % 16 ? 'chorus' : 'verse' });
  const m = buildPhoneModel(w.runs, w.grid, sections, w.dur);
  assert.equal(m.mode, 'bars');
  for (const t of [100.3, 150.7, 200.2, 225.9]) {
    const ci = cellIndexAt(m, t);
    const cell = m.cells[ci];
    const heard = w.runs.findIndex((r) => r.startSec <= t && t < r.endSec);
    assert.ok(cell.slots.some((s) => s.runIndex === heard), `at ${t}s the bar does not hold the chord heard (${w.runs[heard].label})`);
    const k = (cell.startSec - 0.5) / realBar;
    assert.ok(Math.abs(k - Math.round(k)) < 0.05, `at ${t}s the bar line drifted ${(k - Math.round(k)).toFixed(3)} bars`);
  }
});

// ---------------------------------------------------------------------------
// Layout: no blank names, nothing below NAME_MIN_PX
// ---------------------------------------------------------------------------
for (const w of [304, 334]) {
  test(`layoutLine @ ${w}px: every slot of every line named at >= ${NAME_MIN_PX}px, inside its cell`, () => {
    let stacked = 0;
    let twoRows = 0;
    MODEL.lines.forEach((line) => {
      for (const cur of [-1, ...line.cells.flatMap((ci) => MODEL.cells[ci].slots.map((s) => s.runIndex))]) {
        const box = layoutLine(MODEL, RUNS, line, w, cur);
        if (box.rows === 2) twoRows++;
        for (const cb of box.cells) {
          if (cb.stacked) stacked++;
          assert.equal(cb.slots.length, MODEL.cells[cb.cell].slots.length);
          assert.ok(cb.x >= -1e-6 && cb.x + cb.w <= w + 1e-6, 'cell outside the line');
          for (const sb of cb.slots) {
            assert.ok(sb.text.length > 0, 'blank name');
            assert.ok(sb.fontPx >= NAME_MIN_PX, `${sb.text} at ${sb.fontPx}px`);
            assert.ok(sb.wrap || nameWidth(sb.text, sb.fontPx) <= sb.w + 1e-6, `${sb.text} does not fit ${sb.w}px at ${sb.fontPx}px`);
            assert.ok(sb.x >= cb.x - 1e-6 && sb.x + sb.w <= cb.x + cb.w + 1e-6, `${sb.text} slot leaves its cell`);
            assert.ok(sb.y >= cb.y && sb.y + sb.h <= cb.y + cb.h + 1e-6, `${sb.text} slot leaves its cell vertically`);
          }
        }
      }
    });
    assert.ok(twoRows + stacked > 0, 'the turnaround bar never needed the fallback (fixture lost its 4-chord bar?)');
  });
}

test('layoutLine: the B♭ of a 3+1 bar gets room for its name (the bar-76 defect)', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.map((s) => RUNS[s.runIndex].label).join() === 'G:7,Bb:maj');
  const line = MODEL.lines[lineIndexOfCell(MODEL, ci)];
  const box = layoutLine(MODEL, RUNS, line, 304, -1);
  const cb = box.cells.find((c) => c.cell === ci);
  const bb = cb.slots.find((s) => s.text === 'B♭');
  assert.ok(bb && bb.fontPx >= NAME_MIN_PX && nameWidth('B♭', bb.fontPx) <= bb.w + 1e-6);
  const g7 = cb.slots.find((s) => s.text === 'G7');
  assert.ok(g7.w > bb.w, 'the 3-beat chord should still be the wider one');
});

test('layoutLine: a 4-chord bar with C♯m7♭5/G♯ at 304px stacks or wraps rows, never blanks', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.length === 4);
  const line = MODEL.lines[lineIndexOfCell(MODEL, ci)];
  const box = layoutLine(MODEL, RUNS, line, 304, -1);
  assert.equal(box.rows, 2);
  const cb = box.cells.find((c) => c.cell === ci);
  assert.deepEqual(cb.slots.map((s) => s.text), ['Dm7', 'G7', 'C♯m7♭5/G♯', 'C']);
  for (const s of cb.slots) assert.ok(s.fontPx >= NAME_MIN_PX);
});

test('layoutLine: sequence mode lines have no bar-number strip', () => {
  const seq = buildPhoneModel(RUNS, null, SECTIONS, DUR);
  const box = layoutLine(seq, RUNS, seq.lines[3], 304, -1);
  const barsBox = layoutLine(MODEL, RUNS, MODEL.lines[3], 304, -1);
  assert.ok(box.cells[0].slots[0].y < barsBox.cells[0].slots[0].y);
});

// ---------------------------------------------------------------------------
// QA-01: every chord button is >= 24px to tap, and no two overlap
// ---------------------------------------------------------------------------
const QA01_PROG = [
  [['C:maj', 4]],
  [['A:min', 3.5], ['F:maj', 0.5]],
  [['G:maj', 4]],
  [['E:min', 2], ['C:maj', 1.5], ['G:maj', 0.5]],
  [['A:min', 0.5], ['F:maj', 3.5]],
  [['G:maj', 4]],
  [['C:maj', 2], ['F:maj', 2]],
  [['G:7', 4]],
];
const QA01 = song(Array.from({ length: 32 }, (_, k) => QA01_PROG[k % QA01_PROG.length]));
const QA01_MODEL = buildPhoneModel(QA01.runs, QA01.grid, [], QA01.dur);

test('QA-01: MIN_TAP_PX is the brand floor, and a half-beat "F" needs less than it for its name', () => {
  assert.equal(MIN_TAP_PX, 24);
  // The defect: the slot was exactly its name's width (15.3px in Chromium).
  assert.ok(nameWidth('F', NAME_MIN_PX) < MIN_TAP_PX);
});

for (const w of [288, 296, 304, 328, 334, 358]) {
  test(`QA-01 layoutLine @ ${w}px: half-beat chords get >= ${MIN_TAP_PX}px, slots never overlap, time order kept`, () => {
    assert.equal(QA01_MODEL.mode, 'bars', `fell back: ${QA01_MODEL.reason}`);
    let short = 0;
    for (const line of QA01_MODEL.lines) {
      for (const cur of [-1, ...line.cells.flatMap((ci) => QA01_MODEL.cells[ci].slots.map((s) => s.runIndex))]) {
        const box = layoutLine(QA01_MODEL, QA01.runs, line, w, cur);
        const all = box.cells.flatMap((cb) => cb.slots.map((sb) => ({ ...sb, cell: cb })));
        for (const sb of all) {
          const run = QA01.runs[sb.runIndex];
          if (run.endSec - run.startSec < 0.75 * QA01.grid.beatSec) short++;
          assert.ok(sb.w >= MIN_TAP_PX - 1e-6, `${sb.text} slot is ${sb.w.toFixed(2)}px wide @ ${w}px`);
          assert.ok(sb.h >= MIN_TAP_PX, `${sb.text} slot is ${sb.h}px tall`);
          assert.ok(sb.x >= sb.cell.x - 1e-6 && sb.x + sb.w <= sb.cell.x + sb.cell.w + 1e-6, `${sb.text} leaves its cell`);
          assert.ok(sb.wrap || nameWidth(sb.text, sb.fontPx) <= sb.w + 1e-6, `${sb.text} does not fit`);
        }
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++) {
            const a = all[i];
            const b = all[j];
            const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            assert.ok(!(ix > 1e-6 && iy > 1e-6), `${a.text} and ${b.text} overlap @ ${w}px`);
          }
        // Within a side-by-side cell the chords stay in time order, left to right.
        for (const cb of box.cells) {
          if (cb.stacked) continue;
          for (let i = 1; i < cb.slots.length; i++) assert.ok(cb.slots[i].x > cb.slots[i - 1].x, 'slots out of time order');
        }
      }
    }
    assert.ok(short > 20, `only ${short} half-beat slots laid out`);
  });
}

test('QA-01: the floor costs a half-beat chord its proportion only, not its honesty', () => {
  // A|3.5 F|0.5: F is raised to the 24px floor, A keeps the rest and stays
  // the wider; the bar's own width is unchanged.
  const ci = QA01_MODEL.cells.findIndex((c) => c.slots.map((s) => QA01.runs[s.runIndex].label).join() === 'A:min,F:maj' && c.slots[0].share > 0.5);
  assert.ok(ci >= 0);
  const box = layoutLine(QA01_MODEL, QA01.runs, QA01_MODEL.lines[lineIndexOfCell(QA01_MODEL, ci)], 328, -1);
  const cb = box.cells.find((c) => c.cell === ci);
  const [a, f] = cb.slots;
  assert.ok(Math.abs(f.w - MIN_TAP_PX) < 0.5, `F is ${f.w}px, want ~${MIN_TAP_PX}`);
  assert.ok(a.w > 2 * f.w);
  assert.ok(f.x + f.w <= cb.x + cb.w + 1e-6);
});

test('QA-01: a bar too crowded for 24px each side by side falls to two rows or stacks, never below 24px', () => {
  const crowd = song(Array.from({ length: 16 }, (_, k) => (k % 4 === 1 ? [['C:maj', 0.5], ['F:maj', 0.5], ['G:maj', 0.5], ['E:min', 0.5], ['A:min', 2]] : [[['C:maj', 'G:maj', 'A:min', 'F:maj'][k % 4], 4]])));
  const m = buildPhoneModel(crowd.runs, crowd.grid, [], crowd.dur);
  for (const line of m.lines)
    for (const w of [288, 328]) {
      const box = layoutLine(m, crowd.runs, line, w, -1);
      for (const cb of box.cells) for (const sb of cb.slots) assert.ok(sb.w >= MIN_TAP_PX - 1e-6 && sb.h >= MIN_TAP_PX, `${sb.text} ${sb.w}x${sb.h} @ ${w}px (${m.mode})`);
    }
});

// ── Phase A (J5): the countdown under Now ──────────────────────────────────
test('countdownState: bars mode counts the bar\'s beats; 1 segment lit at 4 beats to go, all 4 on the last beat', async () => {
  const { countdownState, countdownText } = await import('../ChordPhone.helpers.ts');
  const model = { mode: 'bars', beatsPerBar: 4 };
  const cell = { startSec: 10, endSec: 12 }; // 0.5 s beats
  const at = (inSec) => countdownState(model, cell, null, { inSec }, { startSec: 9 }, 10.2);
  for (const [inSec, n, lit] of [[3.9, 8, 0], [2.4, 5, 0], [1.9, 4, 1], [1.4, 3, 2], [0.9, 2, 3], [0.4, 1, 4]]) {
    const cd = at(inSec);
    assert.equal(cd.kind, 'beats');
    assert.equal(cd.beatsLeft, n, `${inSec}s`);
    assert.equal(cd.filled, lit, `${inSec}s`);
    assert.equal(cd.lastBeat, n === 1);
  }
  assert.equal(countdownText(at(0.4)), '1 beat');
  assert.equal(countdownText(at(1.4)), '3 beats');
});

test('countdownState: the plain-list mode still counts beats on the measured grid; no grid -> time; no next -> none', async () => {
  const { countdownState, countdownText } = await import('../ChordPhone.helpers.ts');
  const seq = { mode: 'sequence', beatsPerBar: 4 };
  const grid = { beatSec: 0.6, anchorSec: 0, measured: true };
  const cd = countdownState(seq, null, grid, { inSec: 1.5 }, { startSec: 9 }, 10);
  assert.deepEqual([cd.kind, cd.beatsLeft, cd.filled], ['beats', 3, 2]);
  // A pseudo-bar grid is not a tempo: time, not beats.
  assert.equal(countdownState(seq, null, { ...grid, measured: false }, { inSec: 1.5 }, { startSec: 9 }, 10).kind, 'time');
  const t = countdownState(seq, null, null, { inSec: 1.5 }, { startSec: 9 }, 10);
  assert.equal(t.kind, 'time');
  assert.ok(Math.abs(t.fraction - 0.4) < 1e-9, 'one of 2.5 s gone');
  assert.equal(t.filled, 1);
  assert.equal(countdownText(t), '1.5 s');
  assert.equal(countdownState(seq, null, null, { inSec: 0.4 }, { startSec: 9 }, 10).lastBeat, true);
  assert.equal(countdownState(seq, null, null, null, null, 10).kind, 'none');
  assert.equal(countdownText(countdownState(seq, null, null, { inSec: 12.3 }, null, 10)), '12 s');
});

// ── #379: the countdown follows the local bar length on a drifting track ──
// Loops cut on #376's beat-following grid: 4-bar loops at 118 BPM early, 124 BPM late
// (job bpm 121). Each loop appears once per stem.
const DRIFT_ROWS = [
  [1.0, 1.0 + (16 * 60) / 118],
  [40.0, 40.0 + (16 * 60) / 121],
  [80.0, 80.0 + (16 * 60) / 124],
].flatMap(([s, e]) => ['drums', 'bass'].map((stem) => ({ stem, bpm: '121.00', start_sec: String(s), end_sec: String(e), bar_count: 4 })));

test('beatGridFromLoops: local beat spans only when loop lengths show drift; steady and old rows keep the one-BPM shape', async () => {
  const { localBeatSec } = await import('../../lib/play/sections.ts');
  const g = beatGridFromLoops(DRIFT_ROWS);
  assert.equal(g.beatSec, 60 / 121);
  assert.equal(g.spans.length, 3, 'one span per loop, not per stem');
  assert.ok(Math.abs(localBeatSec(g, 5) - 60 / 118) < 1e-9, 'inside the first loop');
  assert.ok(Math.abs(localBeatSec(g, 85) - 60 / 124) < 1e-9, 'inside the last loop');
  assert.ok(Math.abs(localBeatSec(g, 70) - 60 / 124) < 1e-9, 'between loops: the nearest one');
  assert.ok(Math.abs(localBeatSec(g, 200) - 60 / 124) < 1e-9, 'after the last loop');
  // Steady (and pre-#376) rows: every loop is bar_count bars of the one BPM -> no spans.
  const steady = [0.4, 30.4].map((s) => ({ bpm: 96, start_sec: s, end_sec: s + 4 * 4 * 0.625, bar_count: 4 }));
  assert.deepEqual(beatGridFromLoops(steady), { beatSec: 0.625, anchorSec: 0.4, measured: true });
  assert.equal(localBeatSec(beatGridFromLoops(steady), 10), 0.625);
  // bar_count missing: bars are inferred from the length.
  const inferred = beatGridFromLoops(DRIFT_ROWS.map((r) => ({ ...r, bar_count: undefined })));
  assert.ok(Math.abs(localBeatSec(inferred, 85) - 60 / 124) < 1e-9);
  // A loop that is not whole bars of anything near the tempo is ignored.
  assert.equal(beatGridFromLoops([{ bpm: 120, start_sec: 0, end_sec: 9.0, bar_count: 4 }]).spans, undefined);
});

test('localBeatSec: overlapping spans -> the latest-starting span holding t; a shared edge -> the next span (#407 residue)', async () => {
  const { localBeatSec } = await import('../../lib/play/sections.ts');
  // Spans as beatGridFromLoops returns them: sorted by start.
  const A = { startSec: 0, endSec: 20, beatSec: 0.5 };
  const B = { startSec: 10, endSec: 30, beatSec: 0.48 };
  const overlap = { beatSec: 0.49, spans: [A, B] };
  assert.equal(localBeatSec(overlap, 5), 0.5, 'only A holds t');
  assert.equal(localBeatSec(overlap, 15), 0.48, 'A and B both hold t: B starts later and wins');
  assert.equal(localBeatSec(overlap, 25), 0.48, 'only B holds t');
  // A short loop inside a long one: the inner (later-starting) one while it holds t, the outer one after.
  const outer = { startSec: 0, endSec: 40, beatSec: 0.5 };
  const inner = { startSec: 10, endSec: 20, beatSec: 0.47 };
  const nested = { beatSec: 0.49, spans: [outer, inner] };
  assert.equal(localBeatSec(nested, 15), 0.47, 'inside the inner loop');
  assert.equal(localBeatSec(nested, 30), 0.5, 'past the inner loop: only the outer one holds t');
  // Adjacent spans: exactly at the shared edge the next span wins, not the one that just ended.
  const adj = { beatSec: 0.49, spans: [{ startSec: 0, endSec: 10, beatSec: 0.5 }, { startSec: 10, endSec: 20, beatSec: 0.48 }] };
  assert.equal(localBeatSec(adj, 10), 0.48, 'at the shared edge');
  assert.equal(localBeatSec(adj, 0), 0.5, 'at the first span start');
  assert.equal(localBeatSec(adj, 20), 0.48, 'at the last span end');
});

test('countdownState: the plain-list countdown counts the LOCAL beat on a drifting track (#379)', async () => {
  const { countdownState } = await import('../ChordPhone.helpers.ts');
  const seq = { mode: 'sequence', beatsPerBar: 4 };
  const g = beatGridFromLoops(DRIFT_ROWS);
  for (const [t, bpm, start] of [[5, 118, 1], [85, 124, 80]]) {
    const beat = 60 / bpm;
    const at = (n, grid = g) => countdownState(seq, null, grid, { inSec: n * beat - 0.01 }, { startSec: start }, t);
    for (const n of [1, 2, 3, 4, 8, 16]) assert.equal(at(n).beatsLeft, n, `${n} beats at ${bpm} bpm`);
  }
  // Guard: the one-BPM count (121) is wrong here. In the slow (118) stretch it already
  // says 5 with 4 beats to go, so the 4-segment bar lit one segment late.
  const oneBpm = { beatSec: g.beatSec, anchorSec: 0, measured: true };
  const cd = countdownState(seq, null, oneBpm, { inSec: 4 * (60 / 118) - 0.01 }, { startSec: 1 }, 5);
  assert.equal(cd.beatsLeft, 5);
  assert.equal(countdownState(seq, null, g, { inSec: 4 * (60 / 118) - 0.01 }, { startSec: 1 }, 5).filled, 1);
});

test('phoneSlotLabel: " — edit" only on a cell that opens the editor', async () => {
  const { phoneSlotLabel } = await import('../ChordPhone.helpers.ts');
  const run = { kind: 'chord', label: 'E:min7' };
  assert.equal(phoneSlotLabel(run, 2, false), 'E minor 7, 2 beats');
  assert.equal(phoneSlotLabel(run, 2, true), 'E minor 7, 2 beats — edit');
});
