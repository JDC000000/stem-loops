// "Simple" chords (Phase A, D6; Jon 2026-11-21). A DISPLAY layer over the
// chord timeline: the stored chord data (play.chords.json) is never changed.
//
// Why: the chord provider reports every passing chord it hears. The flagship
// demo has 201 changes in 3:33 (57 a minute), 87 of them shorter than one beat
// and the shortest 93 ms. Nobody can fret that, and the big "Now" chord
// flickers through it. Simple mode shows the chords a player would actually
// play:
//
//   1. MERGE every chord shorter than one beat into a neighbour (the longer
//      real chord; "no chord" only when there is nothing else), repeating until
//      no chord is shorter than a beat. Neighbours with the same name join.
//   2. SNAP every change to the nearest beat of the song's beat grid. The grid
//      is re-anchored at each section start (the worker snaps those to a
//      beat), so tempo drift stays inside one section.
//   3. Merge again: a re-anchored snap can leave a sliver under a beat.
//
// With no beat grid (a beatless or rubato song, or no tempo at all) there is
// nothing to snap to, so only step 1 runs, with MIN_CHORD_SEC_NO_GRID as the
// "too short" line.
//
// Pure and node-loadable (no DOM, explicit .ts imports): test/play-simplify-chords.test.mjs.

/** Without a beat grid, a chord shorter than this is merged into a neighbour. */
export const MIN_CHORD_SEC_NO_GRID = 0.5;
/** A gap in the chord data longer than this is never bridged by a merge. */
export const MAX_BRIDGE_SEC = 1;

export interface ChordSpan {
  readonly startSec: number;
  readonly endSec: number;
  readonly label: string;
}

export interface SimplifyGrid {
  /** Seconds per beat. */
  readonly beatSec: number;
  /** Time of any one beat (the grid's phase). */
  readonly anchorSec: number;
}

export interface SimplifyOptions {
  /** The song's beat grid, or null when there is none (then: time-based merge only). */
  readonly grid?: SimplifyGrid | null;
  /** Section start times: each is on a beat, and re-anchors the grid from there on. */
  readonly anchors?: readonly number[];
}

/** "No chord" and "unknown" are not chords a player holds. */
function isChord(label: string): boolean {
  return label !== 'N' && label !== 'X' && label.trim() !== '';
}

const validGrid = (g: SimplifyGrid | null | undefined): g is SimplifyGrid =>
  !!g && Number.isFinite(g.beatSec) && g.beatSec > 0.15 && g.beatSec < 2 && Number.isFinite(g.anchorSec);

type Mut<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The chord timeline as a player would read it. Returns NEW objects (copies of
 * the input runs with only startSec / endSec changed, and fewer of them); the
 * input is not modified. Order is kept; the first start and the last end never
 * move.
 */
export function simplifyChords<T extends ChordSpan>(runs: readonly T[], opts: SimplifyOptions = {}): T[] {
  const grid = validGrid(opts.grid) ? opts.grid : null;
  const minSec = grid ? grid.beatSec : MIN_CHORD_SEC_NO_GRID;
  const out: Mut<T>[] = runs
    .filter((r) => r && Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.startSec - b.startSec);
  if (out.length <= 1) return out;

  join(out);
  merge(out, minSec);
  if (grid) {
    snap(out, grid, anchorsOf(opts.anchors));
    // A re-anchored snap can leave a sliver; anything left under a beat goes.
    merge(out, minSec * 0.999);
  }
  return out;
}

/** Join neighbours that carry the same name and touch (or nearly touch). */
function join<T extends ChordSpan>(out: Mut<T>[]): void {
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    if (a.label === b.label && b.startSec - a.endSec <= MAX_BRIDGE_SEC) {
      a.endSec = Math.max(a.endSec, b.endSec);
      out.splice(i, 1);
    }
  }
}

/**
 * Merge the SHORTEST chord under `minSec` into a neighbour, until none is left
 * (or none can be merged: a short chord alone between long gaps stays).
 * Target: a real chord over "no chord"; then the longer neighbour; then the
 * earlier one (the chord being held, not the one arriving).
 */
function merge<T extends ChordSpan>(out: Mut<T>[], minSec: number): void {
  const stuck = new Set<Mut<T>>();
  for (;;) {
    let i = -1;
    for (let k = 0; k < out.length; k++) {
      const d = out[k].endSec - out[k].startSec;
      if (d < minSec - 1e-9 && !stuck.has(out[k]) && (i < 0 || d < out[i].endSec - out[i].startSec)) i = k;
    }
    if (i < 0 || out.length <= 1) return;
    const r = out[i];
    const cands: number[] = [];
    if (i > 0 && r.startSec - out[i - 1].endSec <= MAX_BRIDGE_SEC) cands.push(i - 1);
    if (i < out.length - 1 && out[i + 1].startSec - r.endSec <= MAX_BRIDGE_SEC) cands.push(i + 1);
    if (cands.length === 0) {
      stuck.add(r);
      continue;
    }
    const rank = (k: number) => [isChord(out[k].label) ? 1 : 0, out[k].endSec - out[k].startSec, k < i ? 1 : 0];
    cands.sort((p, q) => {
      const a = rank(p);
      const b = rank(q);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    });
    const t = out[cands[0]];
    t.startSec = Math.min(t.startSec, r.startSec);
    t.endSec = Math.max(t.endSec, r.endSec);
    out.splice(i, 1);
    join(out);
  }
}

function anchorsOf(a: readonly number[] | undefined): number[] {
  return (a ?? []).filter((x) => Number.isFinite(x) && x >= 0).slice().sort((p, q) => p - q);
}

/** The nearest beat to `t`, on the grid re-anchored at the last section start at or before it. */
export function snapToBeat(t: number, grid: SimplifyGrid, anchors: readonly number[] = []): number {
  let a = grid.anchorSec;
  for (const s of anchors) {
    if (s <= t + grid.beatSec / 2) a = s;
    else break;
  }
  return a + Math.round((t - a) / grid.beatSec) * grid.beatSec;
}

/**
 * Move every chord change onto a beat. The song's first start and last end stay;
 * a change that snaps onto (or before) the previous one removes the chord
 * between them.
 */
function snap<T extends ChordSpan>(out: Mut<T>[], grid: SimplifyGrid, anchors: readonly number[]): void {
  const first = out[0].startSec;
  const last = out[out.length - 1].endSec;
  const at = (t: number) => Math.min(last, Math.max(first, snapToBeat(t, grid, anchors)));
  let floor = first;
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const touching = i > 0 && Math.abs(r.startSec - out[i - 1].endSec) < 1e-6;
    if (i > 0) {
      const s = Math.max(floor, at(r.startSec));
      if (touching) out[i - 1].endSec = s;
      r.startSec = s;
    }
    if (i < out.length - 1) r.endSec = Math.max(r.startSec, at(r.endSec));
    floor = r.endSec;
  }
  out[out.length - 1].endSec = last;
  for (let i = out.length - 1; i >= 0; i--) if (!(out[i].endSec - out[i].startSec > 1e-6)) out.splice(i, 1);
  join(out);
}

/** Chord changes per minute: adjacent chords with different names, over the span covered. */
export function changesPerMinute(runs: readonly ChordSpan[]): number {
  if (runs.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i].label !== runs[i - 1].label) n++;
  const span = runs[runs.length - 1].endSec - runs[0].startSec;
  return span > 0 ? (n / span) * 60 : 0;
}
