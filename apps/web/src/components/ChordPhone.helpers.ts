// Pure helpers for the phone chord view (ChordOverlay under NARROW_BREAKPOINT_PX).
// Node-loadable (no JSX, explicit .ts imports) so every rule here is unit
// tested: src/components/__tests__/ChordPhone.helpers.test.mjs.
//
// THE MODEL. The view shows "cells" in "lines" of up to four:
//   * mode 'bars': a cell is one 4/4 bar. Bars are laid on the job's measured
//     beat grid (loops rows: bpm + beat-snapped start_sec), RE-ANCHORED at every
//     song section (each section starts on a worker-snapped beat), so tempo drift
//     is bounded to one section. Bar 1 is chosen from the chords (downbeatPhase).
//     Bars mode is used ONLY when the grid demonstrably fits the chords
//     (gridFit); otherwise ...
//   * mode 'sequence': a cell is one chord, in order, with no bar lines, no beat
//     dots and no beat counts. Nothing is invented: no tempo, a poor fit, an odd
//     meter (3/4 read as 4/4 fails the downbeat margin) and very dense changes
//     all land here.
// Lines never cross a section, so every section starts a new line.

import { type OverlayRun, activeRunIndex, displayText, estimateLabelPx } from './ChordOverlay.helpers.ts';
import type { BeatGrid } from '../lib/play/sections.ts';

export type { BeatGrid };

/** 4/4, the default. The worker's grid is 4-beat bars too (pipeline.py: bar_sec = 4 * 60 / bpm). */
export const BEATS_PER_BAR = 4;
/** Bars per line in the view (whatever the meter). */
export const LINE_CELLS = 4;
/** A chord that touches a bar for less than this many beats is not drawn in that bar (timing jitter). */
export const MIN_SLOT_BEATS = 0.5;
/** A chord change within this many beats of a beat line counts as "on" it. */
export const BEAT_TOLERANCE = 0.2;
/** Bars mode needs at least this fraction of chord-time to start on a beat. */
export const MIN_FIT_FRACTION = 0.7;
/**
 * ... and the bar structure to be clear: chord-time starting on beats 1+3 must
 * beat chord-time on beats 2+4 (or the other way round) by this factor. Beats
 * are paired because a 4/4 song with TWO chords in every bar votes equally for
 * beat 1 and beat 3; that is a half-bar ambiguity, not an odd meter. An odd
 * meter (3/4 read as 4/4) or one chord per beat spreads the votes over all four.
 */
export const MIN_DOWNBEAT_MARGIN = 1.5;
/**
 * Meter test, run BEFORE the 4/4 test: if this share of on-beat chord-time
 * falls on one phase of a 3-beat cycle, the song is in 3 (or ambiguous) and is
 * not drawn as 4/4 bars. A 4/4 song spreads it evenly (~1/3 per phase).
 */
export const MAX_TRIPLE_SHARE = 0.45;
/**
 * 3/4 (and 6/8 counted in eighths, drawn as two bars of three): at least this
 * share of on-beat chord-time on ONE phase of the 3-beat cycle, beating the
 * next phase by TRIPLE_MARGIN, and NOT also explained by a 4-beat cycle (a
 * change every 12 beats fits both; that is ambiguous and stays a list).
 */
export const MIN_TRIPLE_FOR_34 = 0.6;
export const TRIPLE_MARGIN = 1.5;
export const MAX_QUAD_FOR_34 = 0.6;
/** Inside the winning pair, beat 1 must beat beat 3 by this much to be chosen on votes alone. */
export const HALF_BAR_MARGIN = 1.2;
/** ... and at least this many chord changes to judge by. */
export const MIN_CHANGES = 4;
/** Safety bound on the number of bars built (5 min at 260 bpm is 325 bars). */
export const MAX_CELLS = 2000;

// ---------------------------------------------------------------------------
// Chord symbols
// ---------------------------------------------------------------------------
// Harte ("A:min7", "G:7/5") is the data's spelling and stays in the chord
// editor and the full list. The phone view shows what a chord chart shows
// ("Am7", "G7/D"). Anything not known exactly (a parenthesised extension, an
// unlisted shorthand) is shown as its Harte label, never as a guess.
const LEAD_SHEET_QUALITY: Readonly<Record<string, string>> = Object.freeze({
  '': '', maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', maj6: '6', min6: 'm6',
  maj7: 'maj7', min7: 'm7', '7': '7', dim7: 'dim7', hdim7: 'm7b5', minmaj7: 'm(maj7)', maj9: 'maj9',
  min9: 'm9', '9': '9', '11': '11', '13': '13', min11: 'm11', '5': '5', '1': '',
});
const INTERVAL_SEMIS: Readonly<Record<string, number>> = Object.freeze({
  '1': 0, b2: 1, '2': 2, '#2': 3, b3: 3, '3': 4, '4': 5, '#4': 6, b5: 6, '5': 7, '#5': 8, b6: 8,
  '6': 9, bb7: 9, b7: 10, '7': 11, b9: 1, '9': 2, '#9': 3, '11': 5, '#11': 6, b13: 8, '13': 9,
});
const ROOT_PC: Readonly<Record<string, number>> = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function parseRoot(s: string): { name: string; pc: number } | null {
  const m = /^([A-G])((?:#|b)*)$/.exec(s);
  if (!m) return null;
  let pc = ROOT_PC[m[1]];
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
  return { name: s, pc: ((pc % 12) + 12) % 12 };
}

/** "A:min7" -> "Am7", "G:7/5" -> "G7/D", "Bb:maj" -> "Bb", "C:1" -> "C". N -> "N.C.", X -> "?". */
export function leadSheetSymbol(run: Pick<OverlayRun, 'kind' | 'label'>): string {
  if (run.kind !== 'chord') return displayText(run);
  const label = run.label;
  const slash = label.indexOf('/');
  const body = slash >= 0 ? label.slice(0, slash) : label;
  const bassTok = slash >= 0 ? label.slice(slash + 1) : null;
  if (body.includes('(')) return label;
  const colon = body.indexOf(':');
  const root = parseRoot(colon >= 0 ? body.slice(0, colon) : body);
  const shorthand = colon >= 0 ? body.slice(colon + 1) : '';
  if (!root || !(shorthand in LEAD_SHEET_QUALITY)) return label;
  let out = root.name + LEAD_SHEET_QUALITY[shorthand];
  if (bassTok !== null) {
    const semis = INTERVAL_SEMIS[bassTok];
    if (semis === undefined) return label;
    if (semis !== 0) {
      const flats = root.name.includes('b') || root.name === 'F';
      out += '/' + (flats ? FLAT_NAMES : SHARP_NAMES)[(root.pc + semis) % 12];
    }
  }
  return out;
}

/**
 * Accessible name of a phone slot. It STARTS with the visible text (WCAG 2.5.3
 * label in name: "tap Em7" must work), then the data's own spelling when it
 * differs, then how long the chord is held in this bar.
 */
export function phoneSlotLabel(run: Pick<OverlayRun, 'kind' | 'label'>, beats: number | null): string {
  const sym = leadSheetSymbol(run);
  const what = run.kind === 'none' ? ' (no chord)' : run.kind === 'unknown' ? ' (unknown chord)' : sym !== run.label ? ` (${run.label})` : '';
  const held = beats === null ? '' : `, ${fmtBeats(beats)} beat${Math.abs(beats - 1) < 0.05 ? '' : 's'}`;
  return `${sym}${what}${held} — edit`;
}

/**
 * Accessible name of a bar: its place and its chords in order, in the visible
 * spelling ("Bar 3 of 16, Chorus 2: G7, Bb").
 */
export function phoneBarLabel(model: PhoneModel, runs: readonly Pick<OverlayRun, 'kind' | 'label'>[], cell: number): string {
  const c = model.cells[cell];
  if (!c) return '';
  const sec = c.section >= 0 ? model.sections[c.section]?.name ?? null : null;
  const chords = c.slots.map((s) => leadSheetSymbol(runs[s.runIndex])).join(', ');
  return `Bar ${c.numberInSection} of ${c.countInSection}${sec ? `, ${sec}` : ''}: ${chords}`;
}

function fmtBeats(b: number): string {
  const r = Math.round(b * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
export interface PhoneSection {
  readonly startSec: number;
  readonly endSec: number;
  /** "Chorus 2" when a label repeats, "Verse" when it does not (same rule as nameRegions in lib/play/sections.ts). */
  readonly name: string | null;
}

const titleCase = (s: string) => s.replace(/(^|\s)(\S)/g, (_m, sp: string, c: string) => sp + c.toUpperCase());
const normLabel = (l: unknown) => (typeof l === 'string' ? l.trim().replace(/\s+/g, ' ').toLowerCase() : '');

/** Valid, sorted, non-overlapping, named sections. */
export function phoneSections(
  regions: readonly { readonly startSec: number; readonly endSec: number; readonly label?: string }[] | null | undefined,
  durSec: number,
): PhoneSection[] {
  if (!Array.isArray(regions)) return [];
  const ok = regions
    .filter((r) => r && Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec && r.startSec >= 0 && r.startSec < durSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const out: { startSec: number; endSec: number; label: string }[] = [];
  for (const r of ok) {
    const prev = out[out.length - 1];
    if (prev && r.startSec < prev.endSec - 1e-6) continue; // overlap: keep the first
    out.push({ startSec: r.startSec, endSec: Math.min(r.endSec, durSec), label: normLabel(r.label) });
  }
  const total = new Map<string, number>();
  for (const r of out) if (r.label) total.set(r.label, (total.get(r.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return out.map((r) => {
    if (!r.label) return { startSec: r.startSec, endSec: r.endSec, name: null };
    const n = (seen.get(r.label) ?? 0) + 1;
    seen.set(r.label, n);
    return { startSec: r.startSec, endSec: r.endSec, name: (total.get(r.label) ?? 0) > 1 ? `${titleCase(r.label)} ${n}` : titleCase(r.label) };
  });
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------
export interface PhoneSlot {
  readonly runIndex: number;
  /** Beats of this cell the chord holds (bars mode); null in sequence mode. */
  readonly beats: number | null;
  /** Share of the cell's time, 0..1 (sums to ~1 over a cell's slots). */
  readonly share: number;
  /** The chord started in an earlier bar and is still held. */
  readonly held: boolean;
}

export interface PhoneCell {
  readonly startSec: number;
  readonly endSec: number;
  readonly slots: readonly PhoneSlot[];
  /** Index into model.sections, or -1 for music before the first section. */
  readonly section: number;
  /** 1-based position inside its section (never 0, never negative). */
  readonly numberInSection: number;
  readonly countInSection: number;
}

export interface PhoneLine {
  readonly cells: readonly number[];
  readonly section: number;
}

export interface PhoneModel {
  readonly mode: 'bars' | 'sequence';
  /** Beats in a bar: 4 (4/4) or 3 (3/4, 6/8 in eighths). 4 in sequence mode (unused there). */
  readonly beatsPerBar: 3 | 4;
  /** Why bars mode was not used (sequence only). */
  readonly reason: 'ok' | 'no-grid' | 'poor-fit' | 'meter' | 'few-changes' | 'too-many';
  readonly sections: readonly PhoneSection[];
  readonly cells: readonly PhoneCell[];
  readonly lines: readonly PhoneLine[];
}

interface Seg {
  start: number;
  end: number;
  anchor: number;
  section: number;
  beat: number;
  /** Beat number of `anchor`, counted from the grid's first beat across sections (for meter tests). */
  index0: number;
}

/** Time spans each with its own beat anchor: one per section, plus the stretch before the first. */
function segmentsFor(sections: readonly PhoneSection[], grid: BeatGrid, durSec: number): Seg[] {
  if (sections.length === 0) return [{ start: 0, end: durSec, anchor: grid.anchorSec, section: -1, beat: grid.beatSec, index0: 0 }];
  // A section start is a worker-snapped beat, so it is the anchor, EXCEPT one
  // clamped to 0 (music from the very top): that takes the grid's own beat.
  const anchorOf = (t: number) => {
    if (t >= 0.05) return t;
    const k = Math.ceil((t - grid.anchorSec) / grid.beatSec - 1e-9);
    return grid.anchorSec + k * grid.beatSec;
  };
  const segs: Seg[] = [];
  const a0 = anchorOf(sections[0].startSec);
  const anchors = sections.map((s, i) => (i === 0 ? a0 : anchorOf(s.startSec)));
  // Each section's own beat: its anchor-to-anchor span divided into whole
  // beats. That is what bounds tempo drift to one section.
  const localBeat = (i: number): number => {
    // The last section has no next anchor: it keeps the previous section's beat.
    if (i + 1 >= anchors.length) return i > 0 ? localBeat(i - 1) : grid.beatSec;
    const span = anchors[i + 1] - anchors[i];
    const n = Math.round(span / grid.beatSec);
    const b = n >= 1 ? span / n : grid.beatSec;
    return Math.abs(b / grid.beatSec - 1) <= 0.06 ? b : grid.beatSec;
  };
  // Beat numbers carried from section to section in whole local beats, so a
  // drifting tempo does not scramble a beat count taken modulo the meter.
  const index0: number[] = [Math.round((a0 - grid.anchorSec) / grid.beatSec)];
  for (let i = 1; i < anchors.length; i++) index0.push(index0[i - 1] + Math.round((anchors[i] - anchors[i - 1]) / localBeat(i - 1)));
  if (sections[0].startSec > 0) segs.push({ start: 0, end: sections[0].startSec, anchor: a0, section: -1, beat: localBeat(0), index0: index0[0] });
  sections.forEach((s, i) => {
    const end = i + 1 < sections.length ? sections[i + 1].startSec : durSec;
    segs.push({ start: s.startSec, end, anchor: anchors[i], section: i, beat: localBeat(i), index0: index0[i] });
  });
  return segs;
}

function segAt(segs: readonly Seg[], t: number): Seg {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo];
}

/**
 * Downbeat votes: for each chord change, the beat phase (0-3, relative to the
 * local section anchor) it starts on, weighted by how long the new chord lasts.
 */
export function downbeatVotes(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind'>[],
  sections: readonly PhoneSection[],
  grid: BeatGrid,
  durSec: number,
): { phase: number; phase3: number; scores: number[]; scores3: number[]; pairs: [number, number]; triple: number; quad: number; halfBarTie: boolean; aligned: number; total: number; changes: number } {
  const scores = new Array<number>(BEATS_PER_BAR).fill(0);
  const scores3 = [0, 0, 0];
  let aligned = 0;
  let total = 0;
  let changes = 0;
  let firstPhase = -1;
  if (!(grid.beatSec > 0)) return { phase: 0, phase3: 0, scores, scores3, pairs: [0, 0], triple: 0, quad: 0, halfBarTie: false, aligned, total, changes };
  const segs = segmentsFor(sections, grid, durSec);
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.kind === 'none') continue;
    if (firstPhase < 0) {
      // The first chord after silence: the tie-breaker for a half-bar ambiguity.
      const seg0 = segAt(segs, r.startSec);
      const b0 = (r.startSec - seg0.anchor) / seg0.beat;
      firstPhase = Math.abs(b0 - Math.round(b0)) <= BEAT_TOLERANCE ? ((Math.round(b0) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR : 0;
    }
    if (i === 0) continue;
    const d = Math.max(0, r.endSec - r.startSec);
    changes++;
    total += d;
    const seg = segAt(segs, r.startSec);
    const beats = (r.startSec - seg.anchor) / seg.beat;
    const nearest = Math.round(beats);
    if (Math.abs(beats - nearest) > BEAT_TOLERANCE) continue;
    aligned += d;
    scores[((nearest % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR] += d;
    const g = seg.index0 + nearest;
    scores3[((g % 3) + 3) % 3] += d;
  }
  // Share of on-beat chord-time on ONE phase of a 3-beat cycle: high for 3/4
  // (and 6/8 counted in eighths) whatever the change rate, ~1/3 for 4/4.
  const triple = aligned > 0 ? Math.max(...scores3) / aligned : 0;
  const quad = aligned > 0 ? Math.max(...scores) / aligned : 0;
  let phase3 = 0;
  for (let k = 1; k < 3; k++) if (scores3[k] > scores3[phase3] + 1e-9) phase3 = k;
  const pairs: [number, number] = [scores[0] + scores[2], scores[1] + scores[3]];
  const q = pairs[1] > pairs[0] + 1e-9 ? 1 : 0;
  const a = scores[q];
  const b = scores[q + 2];
  let phase: number;
  let halfBarTie = false;
  if (a >= HALF_BAR_MARGIN * b && a > 0) phase = q;
  else if (b >= HALF_BAR_MARGIN * a && b > 0) phase = q + 2;
  else {
    halfBarTie = true;
    phase = firstPhase === q || firstPhase === q + 2 ? firstPhase : q;
  }
  return { phase, phase3, scores, scores3, pairs, triple, quad, halfBarTie, aligned, total, changes };
}

/**
 * Does the grid fit the chords well enough to draw bars, and in which meter?
 * METER FIRST: a confident 3-beat cycle draws 3/4 bars; any other sign of a
 * 3-beat cycle (an uncertain band, or a 12-beat cycle that fits 3/4 and 4/4
 * alike) draws no bars; only then the 4/4 test, beats 1+3 against 2+4 (two
 * chords in every bar passes it).
 */
export function meterFit(votes: ReturnType<typeof downbeatVotes>): { reason: PhoneModel['reason']; beatsPerBar: 3 | 4 } {
  const no = (reason: PhoneModel['reason']) => ({ reason, beatsPerBar: 4 as const });
  if (votes.changes < MIN_CHANGES || !(votes.total > 0)) return no('few-changes');
  if (votes.aligned / votes.total < MIN_FIT_FRACTION) return no('poor-fit');
  const s3 = [...votes.scores3].sort((a, b) => b - a).map((x) => x / votes.aligned);
  if (s3[0] >= MIN_TRIPLE_FOR_34 && s3[0] >= TRIPLE_MARGIN * s3[1] && votes.quad <= MAX_QUAD_FOR_34) return { reason: 'ok', beatsPerBar: 3 };
  if (votes.triple >= MAX_TRIPLE_SHARE) return no('meter');
  const [hi, lo] = [...votes.pairs].sort((a, b) => b - a);
  if (hi < MIN_DOWNBEAT_MARGIN * lo) return no('meter');
  return { reason: 'ok', beatsPerBar: 4 };
}

/** meterFit's verdict alone. */
export function gridFit(votes: ReturnType<typeof downbeatVotes>): PhoneModel['reason'] {
  return meterFit(votes).reason;
}

function linesFor(cells: readonly PhoneCell[]): PhoneLine[] {
  const lines: PhoneLine[] = [];
  let cur: number[] = [];
  let sec = Number.NaN;
  cells.forEach((c, i) => {
    if (c.section !== sec || cur.length === LINE_CELLS) {
      if (cur.length) lines.push({ cells: cur, section: sec });
      cur = [];
      sec = c.section;
    }
    cur.push(i);
  });
  if (cur.length) lines.push({ cells: cur, section: sec });
  return lines;
}

function numberCells(raw: { startSec: number; endSec: number; slots: PhoneSlot[]; section: number }[]): PhoneCell[] {
  const counts = new Map<number, number>();
  for (const c of raw) counts.set(c.section, (counts.get(c.section) ?? 0) + 1);
  const seen = new Map<number, number>();
  return raw.map((c) => {
    const n = (seen.get(c.section) ?? 0) + 1;
    seen.set(c.section, n);
    return { ...c, numberInSection: n, countInSection: counts.get(c.section) ?? n };
  });
}

function sequenceModel(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind'>[],
  sections: readonly PhoneSection[],
  reason: PhoneModel['reason'],
): PhoneModel {
  const secAt = (t: number) => {
    let s = -1;
    for (let i = 0; i < sections.length; i++) if (sections[i].startSec <= t + 1e-6) s = i;
    return s;
  };
  const raw = runs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.endSec > r.startSec)
    .map(({ r, i }) => ({ startSec: r.startSec, endSec: r.endSec, slots: [{ runIndex: i, beats: null, share: 1, held: false }], section: secAt(r.startSec) }));
  const cells = numberCells(raw);
  return { mode: 'sequence', beatsPerBar: 4, reason, sections, cells, lines: linesFor(cells) };
}

/**
 * Build the phone model. `grid` null (no measured tempo) -> sequence mode.
 * Pure; O(runs + bars).
 */
export function buildPhoneModel(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind'>[],
  grid: BeatGrid | null,
  regions: readonly { readonly startSec: number; readonly endSec: number; readonly label?: string }[] | null | undefined,
  durSec: number,
): PhoneModel {
  const sections = phoneSections(regions, durSec);
  if (runs.length === 0 || !(durSec > 0)) return { mode: 'sequence', beatsPerBar: 4, reason: 'few-changes', sections, cells: [], lines: [] };
  if (!grid || !grid.measured || !(grid.beatSec > 0) || !Number.isFinite(grid.beatSec)) return sequenceModel(runs, sections, 'no-grid');
  const votes = downbeatVotes(runs, sections, grid, durSec);
  const fit = meterFit(votes);
  if (fit.reason !== 'ok') return sequenceModel(runs, sections, fit.reason);
  const m = fit.beatsPerBar;

  const beat = grid.beatSec;
  const bar = beat * m;
  // Each segment's first bar line: the downbeat nearest its anchor. In 4/4 the
  // phase is relative to the section anchor (the worker's 4-beat lines); in
  // 3/4 it is a phase of the beat count carried across sections.
  const segs = segmentsFor(sections, grid, durSec);
  const offsetOf = (s: Seg) => (m === 4 ? votes.phase : (((votes.phase3 - s.index0) % 3) + 3) % 3);
  const lineOf = (s: Seg) => {
    const o = offsetOf(s);
    return o <= m / 2 ? s.anchor + o * s.beat : s.anchor + (o - m) * s.beat;
  };
  const raw: { startSec: number; endSec: number; slots: PhoneSlot[]; section: number }[] = [];
  segs.forEach((s, k) => {
    const from = s.section === -1 && k === 0 && sections.length > 0 ? 0 : lineOf(s);
    const to = k + 1 < segs.length ? lineOf(segs[k + 1]) : durSec;
    if (s.section === -1 && sections.length > 0) {
      // Before the first section: whole bars counted BACK from its first bar line.
      const n = to > 0.05 * beat ? Math.ceil(to / bar - 1e-6) : 0;
      for (let j = n; j >= 1; j--) raw.push({ startSec: to - j * bar, endSec: to - (j - 1) * bar, slots: [], section: -1 });
      return;
    }
    if (s.section === -1) {
      // No sections at all: bars from the first bar line at or before 0.
      let first = lineOf(s);
      first -= Math.ceil(first / bar - 1e-9) * bar;
      if (first + bar <= 0.25 * beat) first += bar;
      const n = Math.max(1, Math.ceil((durSec - first) / bar - 1e-6));
      for (let j = 0; j < n; j++) raw.push({ startSec: first + j * bar, endSec: first + (j + 1) * bar, slots: [], section: -1 });
      return;
    }
    const span = to - from;
    if (!(span > 0)) return;
    const last = k + 1 >= segs.length;
    const segBar = s.beat * m;
    const n = last ? Math.max(1, Math.ceil(span / segBar - 1e-6)) : Math.max(1, Math.round(span / segBar));
    // Inside a section the bars share its span evenly: drift is absorbed per section.
    const len = last ? segBar : span / n;
    for (let j = 0; j < n; j++) raw.push({ startSec: from + j * len, endSec: from + (j + 1) * len, slots: [], section: s.section });
  });
  if (raw.length === 0 || raw.length > MAX_CELLS) return sequenceModel(runs, sections, 'too-many');

  // Slots: every run in every bar it holds for >= MIN_SLOT_BEATS; at least its largest overlap.
  const starts = raw.map((c) => c.startSec);
  const cellAt = (t: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  runs.forEach((r, i) => {
    if (!(r.endSec > r.startSec)) return;
    const touches: { c: number; overlap: number; start: number }[] = [];
    for (let c = cellAt(r.startSec); c < raw.length && raw[c].startSec < r.endSec; c++) {
      const s = Math.max(r.startSec, raw[c].startSec);
      const e = Math.min(r.endSec, raw[c].endSec);
      if (e > s) touches.push({ c, overlap: e - s, start: s });
    }
    if (touches.length === 0) return;
    let keep = touches.filter((t) => t.overlap / ((raw[t.c].endSec - raw[t.c].startSec) / m) >= MIN_SLOT_BEATS);
    if (keep.length === 0) keep = [touches.reduce((a, b) => (b.overlap > a.overlap ? b : a))];
    for (const t of keep) {
      const cell = raw[t.c];
      const len = cell.endSec - cell.startSec;
      cell.slots.push({ runIndex: i, beats: (t.overlap / len) * m, share: t.overlap / len, held: r.startSec < cell.startSec - 1e-6 });
    }
  });
  for (const c of raw) {
    c.slots.sort((a, b) => a.runIndex - b.runIndex);
    const sum = c.slots.reduce((a, s) => a + s.share, 0);
    if (sum > 0) c.slots = c.slots.map((s) => ({ ...s, share: s.share / sum }));
  }
  // Bars before the first chord and after the last that hold only "no chord"
  // are not drawn (count-in and tail silence); every other run, N included, is
  // in at least one bar.
  const onlyN = (c: (typeof raw)[number]) => c.slots.every((x) => runs[x.runIndex].kind === 'none');
  let lead = 0;
  while (lead < raw.length && onlyN(raw[lead])) lead++;
  let tail = raw.length;
  while (tail > lead && onlyN(raw[tail - 1])) tail--;
  const cells = numberCells(raw.slice(lead, tail).filter((c) => c.slots.length > 0));
  return { mode: 'bars', beatsPerBar: m, reason: 'ok', sections, cells, lines: linesFor(cells) };
}

/** The cell being played: the last cell that starts at or before `t`; -1 before the first. */
export function cellIndexAt(model: Pick<PhoneModel, 'cells'>, t: number | null | undefined): number {
  const cells = model.cells;
  if (cells.length === 0 || typeof t !== 'number' || !Number.isFinite(t)) return -1;
  if (t < cells[0].startSec) return -1;
  let lo = 0;
  let hi = cells.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cells[mid].startSec <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The cell whose start is nearest `t` (a loop or section edge snapped to the view's bar lines). */
export function nearestCellStart(model: Pick<PhoneModel, 'cells'>, t: number): number {
  const i = cellIndexAt(model, t);
  if (i < 0) return model.cells.length ? 0 : -1;
  const n = model.cells[i + 1];
  return n && Math.abs(n.startSec - t) < Math.abs(model.cells[i].startSec - t) ? i + 1 : i;
}

export function lineIndexOfCell(model: Pick<PhoneModel, 'lines'>, cell: number): number {
  if (cell < 0) return -1;
  return model.lines.findIndex((l) => l.cells.includes(cell));
}

export interface LoopSpan { readonly startSec: number; readonly endSec: number }

const inLoop = (loop: LoopSpan | null | undefined, t: number) => !!loop && t >= loop.startSec && t < loop.endSec;

/**
 * The line after `line`. With a section loop playing, the line holding the
 * loop's end is followed by the line holding its start (what will be heard).
 */
export function nextLineIndex(model: PhoneModel, line: number, loop: LoopSpan | null | undefined, t: number | null): number {
  if (line < 0) return model.lines.length ? 0 : -1;
  if (loop && t !== null && inLoop(loop, t)) {
    const endCell = cellIndexAt(model, loop.endSec - 1e-3);
    if (model.lines[line]?.cells.includes(endCell)) return lineIndexOfCell(model, nearestCellStart(model, loop.startSec));
  }
  return line + 1 < model.lines.length ? line + 1 : -1;
}

export interface NextChord {
  readonly runIndex: number;
  /** When it will sound (seconds of song time from now). */
  readonly inSec: number;
  /** True when it is the chord the section loop wraps back to. */
  readonly wraps: boolean;
}

/**
 * The next chord to play. Searches from the PLAYHEAD (not from run 0, so a
 * gap in the chord data never points at the song's first chord), skips "no
 * chord" and repeats of the chord already sounding, and follows a section loop
 * back to its start.
 */
export function nextChord(
  runs: readonly Pick<OverlayRun, 'startSec' | 'endSec' | 'kind' | 'label'>[],
  t: number | null,
  activeIdx: number,
  loop: LoopSpan | null | undefined,
): NextChord | null {
  if (t === null || !Number.isFinite(t) || runs.length === 0) return null;
  const cur = activeIdx >= 0 ? runs[activeIdx] : null;
  let i = activeIdx >= 0 ? activeIdx + 1 : runs.findIndex((r) => r.startSec > t);
  if (i < 0) i = runs.length;
  while (i < runs.length && (runs[i].kind === 'none' || (cur && runs[i].label === cur.label))) i++;
  if (loop && inLoop(loop, t) && (i >= runs.length || runs[i].startSec >= loop.endSec - 1e-3)) {
    const j = activeRunIndex(runs, loop.startSec + 1e-3);
    if (j >= 0) return { runIndex: j, inSec: Math.max(0, loop.endSec - t), wraps: true };
  }
  if (i >= runs.length) return null;
  return { runIndex: i, inSec: Math.max(0, runs[i].startSec - t), wraps: false };
}

/** Beats until `inSec` from now in `cell` (bars mode), at least 1. */
export function beatsUntil(cell: Pick<PhoneCell, 'startSec' | 'endSec'>, inSec: number, beatsPerBar: number = BEATS_PER_BAR): number {
  const beat = (cell.endSec - cell.startSec) / beatsPerBar;
  if (!(beat > 0)) return 1;
  return Math.max(1, Math.ceil(inSec / beat - 0.05));
}

/** 0-based beat of the bar at `t`. */
export function beatInCell(cell: Pick<PhoneCell, 'startSec' | 'endSec'>, t: number, beatsPerBar: number = BEATS_PER_BAR): number {
  const beat = (cell.endSec - cell.startSec) / beatsPerBar;
  if (!(beat > 0)) return 0;
  return Math.min(beatsPerBar - 1, Math.max(0, Math.floor((t - cell.startSec) / beat + 1e-9)));
}

/** "Chorus 2 · bar 3/16" (bars), "Chorus 2" (sequence), "Bar 2/3" before the first section. */
export function positionLabel(model: PhoneModel, cell: number): string {
  const c = model.cells[cell];
  if (!c) return 'Now';
  const name = c.section >= 0 ? model.sections[c.section]?.name ?? null : null;
  if (model.mode === 'sequence') return name ?? 'Now';
  const pos = `bar ${c.numberInSection}/${c.countInSection}`;
  return name ? `${name} · ${pos}` : pos[0].toUpperCase() + pos.slice(1);
}

// ---------------------------------------------------------------------------
// Line layout: names never blank, never below NAME_MIN_PX
// ---------------------------------------------------------------------------
/** Smallest chord name in a line (brand floor is 11; phone names at arm's length need 14). */
export const NAME_MIN_PX = 14;
export const NAME_SIZES = [20, 16, 14] as const;
export const CURRENT_NAME_SIZES = [24, 20, 16, 14] as const;
/**
 * Slot names are bold and fitted with the headless advance table (Inter 400 at
 * 16px; unknown glyphs at the widest advance) widened by this factor:
 * conservative on purpose. The real-Chromium gate checks nothing clips.
 */
export const BOLD_FACTOR = 1.12;
export const SLOT_PAD_PX = 3;
export const SLOT_GAP_PX = 2;
export const CELL_PAD_PX = 2;
export const CELL_GAP_PX = 4;
/** The bar-number strip on top of a bars-mode cell (numbers never sit on a chord colour). */
export const CELL_HEAD_PX = 16;
export const SLOT_H_PX = 46;
export const STACKED_SLOT_H_PX = 30;

export const nameWidth = (text: string, px: number) => estimateLabelPx(text, px) * BOLD_FACTOR + 2 * SLOT_PAD_PX;

export interface SlotBox { runIndex: number; text: string; x: number; y: number; w: number; h: number; fontPx: number; wrap: boolean }
export interface CellBox { cell: number; x: number; y: number; w: number; h: number; stacked: boolean; slots: SlotBox[] }
export interface LineBox { h: number; rows: 1 | 2; cells: CellBox[] }

function sideBySide(widths: number[], shares: number[], inner: number): number[] | null {
  // Proportional to time, then every slot raised to its own name's need, taking
  // the difference from slots with room to spare.
  const need = widths;
  if (need.reduce((a, b) => a + b, 0) > inner + 1e-6) return null;
  let w = shares.map((s) => s * inner);
  for (let iter = 0; iter < 8; iter++) {
    const deficit = w.reduce((a, x, i) => a + Math.max(0, need[i] - x), 0);
    if (deficit <= 1e-6) break;
    const spare = w.map((x, i) => Math.max(0, x - need[i]));
    const spareSum = spare.reduce((a, b) => a + b, 0);
    w = w.map((x, i) => (x < need[i] ? need[i] : x - (spareSum > 0 ? (deficit * spare[i]) / spareSum : 0)));
  }
  return w;
}

function bestSize(text: string, w: number, sizes: readonly number[]): number | null {
  for (const px of sizes) if (nameWidth(text, px) <= w + 1e-6) return px;
  return null;
}

/**
 * Lay out one line of cells in `widthPx`. Tries, in order:
 *   1. one row of (up to) four cells, chords side by side in proportion to
 *      their beats, each widened to fit its name at >= NAME_MIN_PX;
 *   2. two rows of two cells, the same;
 *   3. two rows of two cells, a crowded cell STACKING its chords one per row.
 * A name never renders blank: the last resort lets it wrap inside its slot.
 */
export function layoutLine(
  model: PhoneModel,
  runs: readonly Pick<OverlayRun, 'kind' | 'label'>[],
  line: PhoneLine,
  widthPx: number,
  currentRun: number,
): LineBox {
  const head = model.mode === 'bars' ? CELL_HEAD_PX : 0;
  const sizesFor = (ri: number) => (ri === currentRun ? CURRENT_NAME_SIZES : NAME_SIZES);
  const texts = (c: PhoneCell) => c.slots.map((s) => leadSheetSymbol(runs[s.runIndex]));
  const attempt = (perRow: number, allowStack: boolean): LineBox | null => {
    const cellW = (widthPx - CELL_GAP_PX * (perRow - 1)) / perRow;
    const boxes: CellBox[] = [];
    let y = 0;
    let rowH = 0;
    let rows = 0;
    for (let k = 0; k < line.cells.length; k++) {
      const col = k % perRow;
      if (col === 0) {
        if (k > 0) y += rowH + CELL_GAP_PX;
        rowH = 0;
        rows++;
      }
      const cell = model.cells[line.cells[k]];
      const t = texts(cell);
      const m = cell.slots.length;
      const inner = cellW - 2 * CELL_PAD_PX - SLOT_GAP_PX * (m - 1);
      const need = t.map((s) => nameWidth(s, NAME_MIN_PX));
      const ws = sideBySide(need, cell.slots.map((s) => s.share), inner);
      const x0 = col * (cellW + CELL_GAP_PX);
      let box: CellBox;
      if (ws) {
        let x = x0 + CELL_PAD_PX;
        const slots = cell.slots.map((s, i) => {
          const sb: SlotBox = { runIndex: s.runIndex, text: t[i], x, y: y + head + CELL_PAD_PX, w: ws[i], h: SLOT_H_PX, fontPx: bestSize(t[i], ws[i], sizesFor(s.runIndex)) ?? NAME_MIN_PX, wrap: false };
          x += ws[i] + SLOT_GAP_PX;
          return sb;
        });
        box = { cell: line.cells[k], x: x0, y, w: cellW, h: head + SLOT_H_PX + 2 * CELL_PAD_PX, stacked: false, slots };
      } else {
        if (!allowStack) return null;
        const w = cellW - 2 * CELL_PAD_PX;
        let sy = y + head + CELL_PAD_PX;
        const slots = cell.slots.map((s, i) => {
          const px = bestSize(t[i], w, sizesFor(s.runIndex));
          const sb: SlotBox = { runIndex: s.runIndex, text: t[i], x: x0 + CELL_PAD_PX, y: sy, w, h: STACKED_SLOT_H_PX, fontPx: px ?? NAME_MIN_PX, wrap: px === null };
          sy += STACKED_SLOT_H_PX + SLOT_GAP_PX;
          return sb;
        });
        box = { cell: line.cells[k], x: x0, y, w: cellW, h: head + m * STACKED_SLOT_H_PX + (m - 1) * SLOT_GAP_PX + 2 * CELL_PAD_PX, stacked: true, slots };
      }
      rowH = Math.max(rowH, box.h);
      boxes.push(box);
    }
    return { h: y + rowH, rows: rows >= 2 ? 2 : 1, cells: boxes };
  };
  return attempt(LINE_CELLS, false) ?? attempt(2, false) ?? (attempt(2, true) as LineBox);
}
