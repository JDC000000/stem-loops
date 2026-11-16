// Unit tests for the phone chord view's pure helpers (ChordPhone.helpers.ts)
// and the beat-grid reader it relies on (beatGridFromLoops, lib/play/sections.ts).
// The rendered view is gated in real Chromium by
// packages/web-browser-gate/test/chord-phone-view.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { activeRunIndex, observationsToRuns } from '../ChordOverlay.helpers.ts';
import {
  BEATS_PER_BAR,
  NAME_MIN_PX,
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
test('leadSheetSymbol: chart spelling, Harte when unsure', () => {
  const cases = {
    'A:min7': 'Am7', 'G:7/5': 'G7/D', 'Bb:maj': 'Bb', 'C:maj6': 'C6', 'F#:min7': 'F#m7', 'F:maj7/3': 'Fmaj7/A',
    'C:hdim7': 'Cm7b5', 'C#:hdim7/5': 'C#m7b5/G#', 'E:sus4/b7': 'Esus4/D', 'C:maj9': 'Cmaj9', 'C:1': 'C', 'C': 'C',
    'Bb:maj/3': 'Bb/D', 'Eb:7/b7': 'Eb7/Db', 'D:min(9)': 'D:min(9)', 'G:weird': 'G:weird', 'H:maj': 'H:maj', 'C:maj/x': 'C:maj/x',
  };
  for (const [h, want] of Object.entries(cases)) assert.equal(leadSheetSymbol(chord(h)), want, h);
  assert.equal(leadSheetSymbol(chord('N')), 'N.C.');
  assert.equal(leadSheetSymbol(chord('X')), '?');
});

test('phoneSlotLabel starts with the visible text (label in name) and says the beats', () => {
  assert.equal(phoneSlotLabel(chord('E:min7'), 2), 'Em7 (E:min7), 2 beats — edit');
  assert.equal(phoneSlotLabel(chord('C'), 1), 'C, 1 beat — edit');
  assert.equal(phoneSlotLabel(chord('N'), null), 'N.C. (no chord) — edit');
  assert.equal(phoneSlotLabel(chord('X'), 3.02), '? (unknown chord), 3 beats — edit');
  assert.equal(phoneSlotLabel(chord('G:7'), 1.5), 'G7 (G:7), 1.5 beats — edit');
  for (const l of ['A:min7', 'C#:hdim7/5', 'Bb:maj'])
    assert.ok(phoneSlotLabel(chord(l), 2).startsWith(leadSheetSymbol(chord(l))), l);
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

test('phoneBarLabel names the bar and its chords in order, in the visible spelling', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.map((s) => RUNS[s.runIndex].label).join() === 'G:7,Bb:maj');
  const c = MODEL.cells[ci];
  assert.equal(phoneBarLabel(MODEL, RUNS, ci), `Bar ${c.numberInSection} of ${c.countInSection}, Bridge: G7, Bb`);
  const four = MODEL.cells.findIndex((x) => x.slots.length === 4);
  assert.match(phoneBarLabel(MODEL, RUNS, four), /^Bar \d+ of 8, Outro: Dm7, G7, C#m7b5\/G#, C$/);
  assert.equal(phoneBarLabel(MODEL, RUNS, 99999), '');
});

test('phoneSections: sorted, clamped, numbered like nameRegions, overlaps dropped', () => {
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
    { startSec: 0, endSec: 20, name: 'Verse' },
    { startSec: 20, endSec: 40, name: 'Chorus 1' },
    { startSec: 40, endSec: 60, name: 'Chorus 2' },
    { startSec: 60, endSec: 100, name: null },
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
  const chorus2 = MODEL.sections.findIndex((s) => s.name === 'Chorus 2');
  const c = MODEL.cells.findIndex((x) => x.section === chorus2 && x.numberInSection === 3);
  assert.equal(positionLabel(MODEL, c), 'Chorus 2 · bar 3/16');
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
  const sec = MODEL.sections.find((s) => s.name === 'Chorus 2');
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
  const sec = MODEL.sections.findIndex((s) => s.name === 'Chorus 2');
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
  const sec = MODEL.sections.find((s) => s.name === 'Chorus 2');
  const ci = nearestCellStart(MODEL, sec.startSec);
  assert.ok(Math.abs(MODEL.cells[ci].startSec - (sec.startSec + BEAT)) < 1e-6);
  assert.equal(MODEL.cells[ci].numberInSection, 1);
  void activeRunIndex;
});

test('positionLabel: bars, sequence, before the first section', () => {
  const seq = buildPhoneModel(RUNS, null, SECTIONS, DUR);
  const ci = cellIndexAt(seq, 120);
  assert.equal(positionLabel(seq, ci), seq.sections[seq.cells[ci].section].name);
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
    assert.equal(positionLabel(m, ci), `Bar ${m.cells[ci].numberInSection}/${m.cells.length}`);
  }
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

test('layoutLine: the Bb of a 3+1 bar gets room for its name (the bar-76 defect)', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.map((s) => RUNS[s.runIndex].label).join() === 'G:7,Bb:maj');
  const line = MODEL.lines[lineIndexOfCell(MODEL, ci)];
  const box = layoutLine(MODEL, RUNS, line, 304, -1);
  const cb = box.cells.find((c) => c.cell === ci);
  const bb = cb.slots.find((s) => s.text === 'Bb');
  assert.ok(bb && bb.fontPx >= NAME_MIN_PX && nameWidth('Bb', bb.fontPx) <= bb.w + 1e-6);
  const g7 = cb.slots.find((s) => s.text === 'G7');
  assert.ok(g7.w > bb.w, 'the 3-beat chord should still be the wider one');
});

test('layoutLine: a 4-chord bar with C#m7b5/G# at 304px stacks or wraps rows, never blanks', () => {
  const ci = MODEL.cells.findIndex((c) => c.slots.length === 4);
  const line = MODEL.lines[lineIndexOfCell(MODEL, ci)];
  const box = layoutLine(MODEL, RUNS, line, 304, -1);
  assert.equal(box.rows, 2);
  const cb = box.cells.find((c) => c.cell === ci);
  assert.deepEqual(cb.slots.map((s) => s.text), ['Dm7', 'G7', 'C#m7b5/G#', 'C']);
  for (const s of cb.slots) assert.ok(s.fontPx >= NAME_MIN_PX);
});

test('layoutLine: sequence mode lines have no bar-number strip', () => {
  const seq = buildPhoneModel(RUNS, null, SECTIONS, DUR);
  const box = layoutLine(seq, RUNS, seq.lines[3], 304, -1);
  const barsBox = layoutLine(MODEL, RUNS, MODEL.lines[3], 304, -1);
  assert.ok(box.cells[0].slots[0].y < barsBox.cells[0].slots[0].y);
});
