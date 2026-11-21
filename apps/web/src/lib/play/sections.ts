/**
 * Derive loopable song sections (`LoopRegion[]`) from a job's `loops` rows.
 * Story 4.5. Pure: no DOM, no engine, no fetch.
 *
 * ROW SHAPE (do not re-derive): `GET /api/jobs/[id]` returns `loops` rows with
 *   id, job_id, stem, section_label, energy_class, start_sec, end_sec,
 *   start_bar, bar_count, bpm, musical_key, r2_key, filename, ...
 * (see apps/worker/migrations/003_loops.sql and `Loop` in @stem-loops/types).
 * Two facts that matter here:
 *   1. Loops exist PER STEM. A 6-stem job repeats every musical section up to
 *      six times, so rows are collapsed to musical sections, not listed.
 *   2. `start_sec` / `end_sec` are Postgres `numeric`, which node-pg returns as
 *      STRINGS ("11.636"), although `Loop` types them `number`. We coerce.
 * `section_label` is NOT NULL and CHECK-constrained in the DB, but the worker's
 * labeller is positional/energy-based, so stems can disagree and we never trust
 * the value to be clean.
 *
 * Rules (each pinned by a test in test/play-sections.test.mjs):
 *   R1 labels are trimmed, whitespace-collapsed and lower-cased; blank -> ignored
 *   R2 rows with non-finite times or end <= start are dropped
 *   R3 times are clamped to [0, durationSec] when a duration is known
 *   R4 times within SNAP_SEC of each other are one boundary (float noise)
 *   R5 where rows overlap, the label with the most rows wins (ties: the label
 *      already running, else alphabetical) - this is what collapses six stems
 *   R6 touching segments with the same label merge
 *   R7 output is sorted by startSec, non-overlapping, every region end > start
 *   R8 CONTIGUOUS (design review D2, Jon 2026-11-21): the worker's rows are
 *      4-bar loop SAMPLES spaced ~20 s apart, so on the demo song 56% of the
 *      track sat in no section. Each region now runs to the start of the next;
 *      the first starts at 0, and the last runs to `durationSec` when known.
 *      Starts are untouched (they are worker-snapped beats).
 *   R9 after R8, adjacent regions with the same label merge into one, so a
 *      "chorus" sampled twice is ONE section (1:50-2:33), not two 4-bar slices.
 *      Labels are only used for this merge: the UI never shows them (D2, see
 *      nameRegions), because the worker's labeller is an energy heuristic.
 */
import type { LoopRegion } from './types';

/** Minimal structural view of a loop row; extra columns are ignored. */
export interface SectionLoopRow {
  readonly section_label?: string | null;
  readonly start_sec?: number | string | null;
  readonly end_sec?: number | string | null;
}

export interface DeriveOptions {
  /** Track length in seconds; regions are clamped to it. Omit if unknown. */
  readonly durationSec?: number;
}

/** Boundaries closer than this are the same boundary. 50 ms << 1 bar at any sane tempo. */
export const SNAP_SEC = 0.05;
/** Two regions closer than this on both ends are the same region. */
export const MATCH_SEC = 0.01;

export function normalizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function toSec(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function validCap(durationSec: number | undefined): number | undefined {
  return durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined;
}

interface Span { label: string; start: number; end: number }

function cleanRows(rows: readonly SectionLoopRow[], durationSec?: number): Span[] {
  const cap = validCap(durationSec) ?? Infinity;
  const out: Span[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const label = normalizeLabel(r.section_label);
    if (!label) continue;
    let start = toSec(r.start_sec);
    let end = toSec(r.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    end = Math.min(cap, end);
    out.push({ label, start, end });
  }
  return out;
}

/** Map every boundary to the first member of its SNAP_SEC cluster. */
function snapper(points: number[]): (x: number) => number {
  const sorted = [...points].sort((a, b) => a - b);
  const rep = new Map<number, number>();
  let cur = Number.NaN;
  for (const p of sorted) {
    if (!(p - cur <= SNAP_SEC)) cur = p; // NaN on first pass -> new cluster
    rep.set(p, cur);
  }
  return (x) => rep.get(x) ?? x;
}

export function deriveSections(
  rows: readonly SectionLoopRow[] | null | undefined,
  opts: DeriveOptions = {},
): LoopRegion[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const spans = cleanRows(rows, opts.durationSec);
  if (spans.length === 0) return [];

  const snap = snapper(spans.flatMap((s) => [s.start, s.end]));
  // Sweep events: +label at start, -label at end. All events at one instant are
  // applied together before the segment after it is read, so order within an
  // instant does not matter. `b <= a` is the single place R2 (end <= start,
  // incl. after clamping) and snap-collapse (a <50 ms loop) are enforced.
  const events: { t: number; label: string; d: 1 | -1 }[] = [];
  for (const s of spans) {
    const a = snap(s.start);
    const b = snap(s.end);
    if (b <= a) continue;
    events.push({ t: a, label: s.label, d: 1 }, { t: b, label: s.label, d: -1 });
  }
  events.sort((x, y) => x.t - y.t);

  const counts = new Map<string, number>();
  const regions: Span[] = [];
  let prevWinner = '';
  let i = 0;
  while (i < events.length) {
    const t = events[i].t;
    while (i < events.length && events[i].t === t) {
      const e = events[i++];
      const n = (counts.get(e.label) ?? 0) + e.d;
      if (n <= 0) counts.delete(e.label); else counts.set(e.label, n);
    }
    if (i >= events.length) break;
    const segEnd = events[i].t;
    if (counts.size === 0) { prevWinner = ''; continue; } // uncovered gap

    const entries = Array.from(counts.entries());
    const best = Math.max(...entries.map((e) => e[1]));
    const tied = entries.filter((e) => e[1] === best).map((e) => e[0]).sort();
    const winner = tied.includes(prevWinner) ? prevWinner : tied[0];

    const last = regions[regions.length - 1];
    if (last && last.label === winner && last.end === t) last.end = segEnd;
    else regions.push({ label: winner, start: t, end: segEnd });
    prevWinner = winner;
  }

  return contiguous(regions, validCap(opts.durationSec))
    .map((r) => ({ startSec: round3(r.start), endSec: round3(r.end), label: r.label }))
    .filter((r) => r.endSec > r.startSec);
}

/** R8 + R9: close every gap (each region runs to the next one's start), then merge same-label neighbours. */
function contiguous(regions: readonly Span[], cap: number | undefined): Span[] {
  const out: Span[] = [];
  regions.forEach((r, i) => {
    const start = i === 0 ? 0 : r.start;
    const next = regions[i + 1];
    const end = next ? next.start : Math.max(r.end, cap ?? r.end);
    const last = out[out.length - 1];
    if (last && last.label === r.label) last.end = end;
    else out.push({ label: r.label, start, end });
  });
  return out;
}

// ─── helpers shared with the component ──────────────────────────────────────

export function isValidRegion(r: unknown): r is LoopRegion {
  if (!r || typeof r !== 'object') return false;
  const { startSec, endSec } = r as LoopRegion;
  return Number.isFinite(startSec) && Number.isFinite(endSec) && startSec >= 0 && endSec > startSec;
}

/** Same time span (labels ignored; the engine may round or clamp what we hand it). */
export function sameRegion(a: LoopRegion | null | undefined, b: LoopRegion | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.startSec - b.startSec) <= MATCH_SEC && Math.abs(a.endSec - b.endSec) <= MATCH_SEC;
}

/**
 * What the control should offer: invalid regions dropped, clamped to the track,
 * sorted by start, near-duplicates removed. Never throws.
 */
export function sanitizeRegions(
  regions: readonly LoopRegion[] | null | undefined,
  durationSec?: number,
): LoopRegion[] {
  if (!Array.isArray(regions)) return [];
  const cap = validCap(durationSec);
  const out: LoopRegion[] = [];
  for (const r of regions) {
    if (!isValidRegion(r)) continue;
    const endSec = cap !== undefined ? Math.min(r.endSec, cap) : r.endSec;
    if (cap !== undefined && endSec <= r.startSec) continue; // starts at or after the end of the track
    const fixed = endSec === r.endSec ? r : { ...r, endSec };
    if (out.some((o) => sameRegion(o, fixed))) continue;
    out.push(fixed);
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

// ─── runs of sections (design v1.4 P2.1; tap/hold swapped by D4, 2026-11-21) ─
//
// State: no loop, or a RUN = sections i..j inclusive (one section is a run with
// i = j). The engine already loops any continuous span (engine.ts setLoop, the
// native AudioBufferSourceNode.loop), so a run is handed to it as ONE region
// from section i's start to section j's end. "Loop off" keeps the run
// REMEMBERED so the loop button can turn it back on.
//
// D4 (Jon, 2026-11-21): a TAP jumps, a HOLD loops. Every row below is one
// branch, in order, pinned by test/play-sections.test.mjs. Indices are into the
// list the strip shows (sanitizeRegions order).
//
//   tapChip  (tap, click, Enter, Space)
//     looping, X inside the run         -> loop off (run remembered), no jump
//     anything else                     -> jump to X and play; a loop that was
//                                          on goes off (run remembered)
//   holdChip (long-press 500 ms, Shift+Enter) — the P2 run model, unchanged
//     no loop / loop off · hold X       -> loop [X]
//     run [i..j] looping · hold outside -> extend to [min(i,X)..max(j,X)]
//     run [i..j], 2+ chips · hold inside-> shrink to [X]
//     run [X] looping · hold X          -> no change (still looping)
//   loopHere (the transport's Loop button), with the playhead in section C
//     looping                           -> loop off (run remembered)
//     off, remembered run contains C    -> that run, on again
//     otherwise                         -> loop [C]

export interface SectionRun {
  readonly lo: number;
  readonly hi: number;
}

export interface RunState {
  /** The run on screen (looping, or remembered while the loop is off). */
  readonly run: SectionRun | null;
  /** True while the run is looping. Always false when `run` is null. */
  readonly on: boolean;
}

export const NO_RUN: RunState = Object.freeze({ run: null, on: false });

export interface ChipTapResult {
  readonly state: RunState;
  /** True when the tap should seek to the chip's section start (and play). */
  readonly jump: boolean;
}

export interface RunHoldResult {
  readonly state: RunState;
  /** True when this hold EXTENDED a run (the one-time hint fires on the first). */
  readonly extended: boolean;
}

const inRun = (run: SectionRun, i: number) => i >= run.lo && i <= run.hi;
const okIndex = (i: number) => Number.isInteger(i) && i >= 0;

/** A tap on chip `i` (D4): jump there and play, or stop the loop it is part of. */
export function tapChip(state: RunState, i: number): ChipTapResult {
  if (!okIndex(i)) return { state, jump: false };
  const { run, on } = state;
  if (run && on && inRun(run, i)) return { state: { run, on: false }, jump: false };
  return { state: run ? { run, on: false } : NO_RUN, jump: true };
}

/** A long-press (or Shift+Enter) on chip `i` (D4): loop it, or extend/shrink the running loop (P2). */
export function holdChip(state: RunState, i: number): RunHoldResult {
  if (!okIndex(i)) return { state, extended: false };
  const { run, on } = state;
  if (!run || !on) return { state: { run: { lo: i, hi: i }, on: true }, extended: false };
  if (!inRun(run, i)) {
    return { state: { run: { lo: Math.min(run.lo, i), hi: Math.max(run.hi, i) }, on: true }, extended: true };
  }
  if (run.lo === run.hi) return { state, extended: false };
  return { state: { run: { lo: i, hi: i }, on: true }, extended: false };
}

/** The transport's Loop button with the playhead in section `current` (-1 = none). */
export function loopHere(state: RunState, current: number): RunState {
  const { run, on } = state;
  if (run && on) return { run, on: false };
  if (run && (!okIndex(current) || inRun(run, current))) return { run, on: true };
  if (!okIndex(current)) return state;
  return { run: { lo: current, hi: current }, on: true };
}

/** Index of the section under `positionSec`, or -1. Sections are contiguous (R8), so -1 only past the end. */
export function sectionAt(sections: readonly LoopRegion[], positionSec: number | null | undefined): number {
  if (sections.length === 0) return -1;
  const t = typeof positionSec === 'number' && Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const i = sections.findIndex((s) => t >= s.startSec && t < s.endSec);
  if (i >= 0) return i;
  // On the last section's end (a finished song) the last section is still "current".
  const last = sections.length - 1;
  return Math.abs(t - sections[last].endSec) <= MATCH_SEC ? last : -1;
}

/**
 * Where "⟲" (back to the start of this section) seeks: the loop's start while
 * a loop is on, else the start of the section under the playhead, else 0.
 */
export function restartTarget(
  sections: readonly LoopRegion[],
  loop: LoopRegion | null | undefined,
  positionSec: number | null | undefined,
): number {
  if (loop && isValidRegion(loop)) return loop.startSec;
  const i = sectionAt(sections, positionSec);
  return i >= 0 ? sections[i].startSec : 0;
}

/** The one continuous span the engine loops for a run, or null when it cannot be built. */
export function runRegion(sections: readonly LoopRegion[], run: SectionRun | null): LoopRegion | null {
  if (!run) return null;
  const a = sections[run.lo];
  const b = sections[run.hi];
  if (!a || !b || run.hi < run.lo) return null;
  const region = { startSec: a.startSec, endSec: b.endSec };
  return isValidRegion(region) ? region : null;
}

/**
 * The run an engine loop corresponds to: the sections whose start and end it
 * matches. Null for no loop or a span that is not a run of these sections
 * (a custom range).
 */
export function runFromRegion(sections: readonly LoopRegion[], region: LoopRegion | null | undefined): SectionRun | null {
  if (!region || !isValidRegion(region)) return null;
  const lo = sections.findIndex((s) => Math.abs(s.startSec - region.startSec) <= MATCH_SEC);
  if (lo < 0) return null;
  for (let hi = lo; hi < sections.length; hi++) {
    if (Math.abs(sections[hi].endSec - region.endSec) <= MATCH_SEC) return { lo, hi };
  }
  return null;
}

/** "Part 2 → Part 3" (screen) / "Part 2 to Part 3" (spoken). */
export function runName(names: readonly string[], run: SectionRun, spoken = false): string {
  const a = names[run.lo] ?? '';
  if (run.hi === run.lo) return a;
  return `${a}${spoken ? ' to ' : ' \u2192 '}${names[run.hi] ?? ''}`;
}

/** The transport readout: "Looping Part 2 → Part 3 · 0:32–1:18", "Loop off", or "". */
export function runReadout(names: readonly string[], sections: readonly LoopRegion[], state: RunState): string {
  if (!state.run) return '';
  if (!state.on) return 'Loop off';
  const region = runRegion(sections, state.run);
  if (!region) return '';
  return `Looping ${runName(names, state.run)} \u00b7 ${formatTime(region.startSec)}\u2013${formatTime(region.endSec)}`;
}

/** The one-time hint the first time the strip is shown (D4, Jon 2026-11-21). */
export const STRIP_HINT = 'Tap to jump \u00b7 hold to loop';
/** The one-time hint after the first extend (P2.1 "signposting the change"). */
export const RUN_HINT = 'Looping these \u00b7 hold one to loop it alone';

/** How the strip is used, in its group label (a screen reader hears it with the group). */
export const STRIP_HOWTO = 'Tap to jump, hold or Shift+Enter to loop';

/** The strip's legend (sr-only): what a screen reader hears for the group. */
export function stripLegend(names: readonly string[], state: RunState): string {
  const head = `Sections. ${STRIP_HOWTO}.`;
  if (!state.run) return `${head} No loop.`;
  const spoken = runName(names, state.run, true);
  return state.on ? `${head} Looping ${spoken}.` : `${head} Loop off, ${spoken} remembered.`;
}

/** m:ss, floored. Bad input renders as 0:00 rather than "NaN:NaN". */
export function formatTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface NamedRegion {
  readonly region: LoopRegion;
  /** "Part 3": neutral, by position (D2). Never the worker's heuristic label. */
  readonly name: string;
  /** The section start, "1:50". */
  readonly time: string;
  /** Colour slot, 0..SECTION_TONES-1, cycling so neighbours always differ. */
  readonly tone: number;
}

/** Section colours cycle through this many tokens (SectionLoop.module.css, Transport ticks). */
export const SECTION_TONES = 3;

/** The display name for section `i` (0-based): "Part 1", "Part 2", ... */
export const partName = (i: number) => `Part ${i + 1}`;

/**
 * Neutral names (D2, Jon 2026-11-21): "Part 1", "Part 2"... plus the start
 * time. The worker labels sections by drum energy (section_labeler.py), so
 * "Chorus" was a guess presented as fact; it is never shown. Renaming comes
 * later (Phase C).
 */
export function nameRegions(regions: readonly LoopRegion[]): NamedRegion[] {
  return regions.map((region, i) => ({ region, name: partName(i), time: formatTime(region.startSec), tone: i % SECTION_TONES }));
}

// ---------------------------------------------------------------------------
// Beat grid (phone chord view)
// ---------------------------------------------------------------------------
// The job's beat grid, for the phone chord view's bars (ChordOverlay). The
// loops rows carry the job's `bpm`, and every loop `start_sec` is snapped to a
// detected beat (apps/worker/src/worker/extractor/beat_grid.py).

/** The worker's tempo guard range, widened a little; outside it the bpm is not believed. */
export const MIN_GRID_BPM = 40;
export const MAX_GRID_BPM = 260;

export interface BeatGrid {
  /** Seconds per beat. */
  readonly beatSec: number;
  /** Time of any one beat, seconds (the grid's phase). */
  readonly anchorSec: number;
  /** True when the grid came from the job's measured tempo; false for the pseudo-bar fallback. */
  readonly measured: boolean;
}

/**
 * The job's beat grid from its `loops` rows (`bpm`, `start_sec`; both may be
 * node-pg numeric strings). Null when there is no believable tempo.
 */
export function beatGridFromLoops(
  rows: readonly { readonly bpm?: unknown; readonly start_sec?: unknown }[] | null | undefined,
): BeatGrid | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let bpm = NaN;
  let anchor = Infinity;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const b = toSec(r.bpm);
    if (!Number.isFinite(bpm) && Number.isFinite(b) && b >= MIN_GRID_BPM && b <= MAX_GRID_BPM) bpm = b;
    const s = toSec(r.start_sec);
    if (Number.isFinite(s) && s >= 0 && s < anchor) anchor = s;
  }
  if (!Number.isFinite(bpm)) return null;
  return { beatSec: 60 / bpm, anchorSec: Number.isFinite(anchor) ? anchor : 0, measured: true };
}

// ─── where am I (the no-chords stage, design v1.4 P1.2) ─────────────────────

export interface SongPlace {
  /** Index of the section under the playhead, or -1. */
  readonly section: number;
  /** 1-based bar within that section, or null without a believable tempo. */
  readonly bar: number | null;
  /** Bars in that section (rounded), or null. */
  readonly bars: number | null;
  /** 1-based beat in the bar, or null. */
  readonly beat: number | null;
}

/**
 * The section, bar and beat under the playhead, for a song with no chords:
 * "Pre-chorus 1 · bar 3 / 8 · beat 2". Bars count 4/4 from the section's start
 * (each section starts on a worker-snapped beat); without a grid only the
 * section is known.
 */
export function placeInSong(
  sections: readonly LoopRegion[],
  grid: BeatGrid | null | undefined,
  positionSec: number | null | undefined,
  beatsPerBar = 4,
): SongPlace {
  const t = typeof positionSec === 'number' && Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const section = sections.findIndex((s) => t >= s.startSec && t < s.endSec);
  if (section < 0) return { section, bar: null, bars: null, beat: null };
  if (!grid || !(grid.beatSec > 0)) return { section, bar: null, bars: null, beat: null };
  const s = sections[section];
  const barSec = grid.beatSec * beatsPerBar;
  const into = t - s.startSec;
  const bar = Math.floor(into / barSec + 1e-6) + 1;
  const bars = Math.max(bar, Math.round((s.endSec - s.startSec) / barSec));
  const beat = (Math.floor(into / grid.beatSec + 1e-6) % beatsPerBar) + 1;
  return { section, bar, bars, beat };
}
