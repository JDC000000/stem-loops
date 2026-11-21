// "Simple" chords (Phase A, D6; Jon 2026-11-21). A DISPLAY layer over the
// chord timeline: the stored chord data (play.chords.json) is never changed.
//
// Why: the chord provider reports every passing chord it hears. The flagship
// demo has 201 changes in 3:33 (57 a minute), 87 of them shorter than one beat
// and the shortest 93 ms. Nobody can fret that, and the big "Now" chord
// flickers through it. Simple mode shows the chords a player would actually
// play:
//
//   1. SAME CHORD, SAME NAME: neighbours with the same root and the same triad
//      (C, Cmaj7, C7, C/E; Em, Em7) are one chord to a player. They join first.
//   2. MERGE every chord shorter than one beat into a neighbour (the real chord
//      over "no chord", then the longer, then the earlier one), repeating until
//      no chord is shorter than a beat. A merge is refused when it would make
//      the merged chord sound for less than half of its span (a run of short,
//      different chords must not all be painted as the one after them), unless
//      no neighbour can take it at all.
//   3. SNAP every change to the nearest beat of the song's beat grid. A section
//      start re-anchors the grid only when it sits on it (within 0.1 beat), so
//      a section that starts at 0 s does not pull a whole intro off the beat.
//   4. Merge again (a snap can leave a sliver under a beat).
//   5. NAME each chord: the plain triad (C, Em) unless one spelling of it
//      (Cmaj7, Em7, C/E) sounds for more than half of its span. A span that no
//      chord holds for half its length (fast alternating chords) is shown as
//      unknown ("?"), never as a chord that is not there.
//
// With no beat grid (a beatless or rubato song) there is nothing to snap to,
// so steps 1, 2 and 5 run, with MIN_CHORD_SEC_NO_GRID as the "too short" line.
//
// Pure and node-loadable (no DOM, explicit .ts imports): test/play-simplify-chords.test.mjs.

/** Without a beat grid, a chord shorter than this is merged into a neighbour. */
export const MIN_CHORD_SEC_NO_GRID = 0.5;
/** A gap in the chord data longer than this is never bridged by a merge. */
export const MAX_BRIDGE_SEC = 1;
/** A section start re-anchors the beat grid only when it is this close to it, in beats. */
export const ANCHOR_TOLERANCE_BEATS = 0.1;
/** A merge may not leave the merged chord sounding for less than this share of its span. */
export const MIN_SOUNDING_SHARE = 0.5;

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
  /** Section start times: each one that is on the grid re-anchors it from there on. */
  readonly anchors?: readonly number[];
}

/** "No chord" and "unknown" are not chords a player holds. */
function isChord(label: string): boolean {
  return label !== 'N' && label !== 'X' && label.trim() !== '';
}

/**
 * The chord a player hears, by root and triad: "C:maj7", "C:7", "C", "C:maj/3"
 * -> "C:maj"; "E:min7", "E:min(9)" -> "E:min"; "B:hdim7" -> "B:dim". N and X
 * are their own family. Exported for the tests.
 */
export function chordFamily(label: string): string {
  if (!isChord(label)) return label;
  const [head] = label.split('/');
  const [root, q = 'maj'] = head.split(':');
  const quality = q.trim();
  let tri = 'maj';
  if (/^min/.test(quality)) tri = 'min';
  else if (/^(dim|hdim)/.test(quality)) tri = 'dim';
  else if (/^aug/.test(quality)) tri = 'aug';
  else if (/sus2/.test(quality)) tri = 'sus2';
  else if (/sus/.test(quality)) tri = 'sus4';
  else if (quality === '1' || quality === '5') tri = quality;
  return `${root.trim()}:${tri}`;
}

const validGrid = (g: SimplifyGrid | null | undefined): g is SimplifyGrid =>
  !!g && Number.isFinite(g.beatSec) && g.beatSec > 0.15 && g.beatSec < 2 && Number.isFinite(g.anchorSec);

type Mut<T> = { -readonly [K in keyof T]: T[K] };
interface Ctx {
  /** The input, sorted and valid: what is actually detected, for the sounding-share guard and the naming. */
  readonly raw: readonly ChordSpan[];
}

/**
 * The chord timeline as a player would read it. Returns NEW objects (copies of
 * the input runs with startSec / endSec / label changed, and fewer of them);
 * the input is not modified. Order is kept; the first start and the last end
 * never move.
 */
export function simplifyChords<T extends ChordSpan>(runs: readonly T[], opts: SimplifyOptions = {}): T[] {
  const grid = validGrid(opts.grid) ? opts.grid : null;
  const minSec = grid ? grid.beatSec : MIN_CHORD_SEC_NO_GRID;
  const out: Mut<T>[] = runs
    .filter((r) => r && Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.startSec - b.startSec);
  if (out.length <= 1) return out;
  const ctx: Ctx = { raw: out.map((r) => ({ startSec: r.startSec, endSec: r.endSec, label: r.label })) };

  const anchors = grid ? anchorsOn(grid, opts.anchors) : [];
  // The guard judges a merge on the span it will have AFTER the beat snap.
  const snapAt = grid ? (t: number) => snapToBeat(t, grid, anchors) : (t: number) => t;
  join(out);
  merge(out, minSec, ctx, snapAt);
  if (grid) {
    snap(out, grid, anchors);
    merge(out, minSec * 0.999, ctx, snapAt);
  }
  name(out, ctx);
  return out;
}

/** Join neighbours of one family (same root and triad) that touch (or nearly touch). */
function join<T extends ChordSpan>(out: Mut<T>[]): void {
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    if (chordFamily(a.label) === chordFamily(b.label) && b.startSec - a.endSec <= MAX_BRIDGE_SEC) {
      a.endSec = Math.max(a.endSec, b.endSec);
      out.splice(i, 1);
    }
  }
}

/** Seconds of [s, e) in which a chord of `family` is detected. */
function soundingSec(ctx: Ctx, family: string, s: number, e: number): number {
  let n = 0;
  for (const x of ctx.raw) {
    if (x.endSec <= s) continue;
    if (x.startSec >= e) break;
    if (chordFamily(x.label) === family) n += Math.min(e, x.endSec) - Math.max(s, x.startSec);
  }
  return n;
}

/**
 * Merge the SHORTEST chord under `minSec` into a neighbour, until none is left
 * (or none can be merged: a short chord alone between long gaps stays).
 * Target: a real chord over "no chord"; then the longer neighbour; then the
 * earlier one (the chord being held, not the one arriving). A target that
 * would then sound for less than MIN_SOUNDING_SHARE of its span is skipped
 * when the other neighbour can take it.
 */
function merge<T extends ChordSpan>(out: Mut<T>[], minSec: number, ctx: Ctx, snapAt: (t: number) => number): void {
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
    const share = (k: number) => {
      const s = snapAt(Math.min(out[k].startSec, r.startSec));
      const e = snapAt(Math.max(out[k].endSec, r.endSec));
      return e > s ? soundingSec(ctx, chordFamily(out[k].label), s, e) / (e - s) : 0;
    };
    const rank = (k: number) => [
      share(k) >= MIN_SOUNDING_SHARE ? 1 : 0,
      isChord(out[k].label) ? 1 : 0,
      out[k].endSec - out[k].startSec,
      k < i ? 1 : 0,
    ];
    cands.sort((p, q) => {
      const a = rank(p);
      const b = rank(q);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || b[3] - a[3];
    });
    const t = out[cands[0]];
    t.startSec = Math.min(t.startSec, r.startSec);
    t.endSec = Math.max(t.endSec, r.endSec);
    out.splice(i, 1);
    join(out);
  }
}

/** The section starts that sit on the global grid (within ANCHOR_TOLERANCE_BEATS), sorted. */
export function anchorsOn(grid: SimplifyGrid, a: readonly number[] | undefined): number[] {
  return (a ?? [])
    .filter((x) => {
      if (!Number.isFinite(x) || x < 0) return false;
      const off = (x - grid.anchorSec) / grid.beatSec;
      return Math.abs(off - Math.round(off)) <= ANCHOR_TOLERANCE_BEATS;
    })
    .slice()
    .sort((p, q) => p - q);
}

/**
 * The nearest beat to `t`, on the grid re-anchored at the last on-grid section
 * start at or before it. `anchors` should come from anchorsOn.
 */
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
  for (let i = out.length - 1; i >= 0; i--) if (!(out[i].endSec - out[i].startSec > 1e-6)) out.splice(i, 1);
  join(out);
}

/**
 * Name each chord: the spelling detected for more than half of its span when
 * there is one (Cmaj7 held throughout stays Cmaj7); otherwise the plain triad
 * of its family (C, Em). "No chord" and "unknown" keep their names.
 */
function name<T extends ChordSpan>(out: Mut<T>[], ctx: Ctx): void {
  for (const r of out) {
    const fam = chordFamily(r.label);
    if (!isChord(r.label)) continue;
    const by = new Map<string, number>();
    for (const x of ctx.raw) {
      if (x.endSec <= r.startSec || x.startSec >= r.endSec || chordFamily(x.label) !== fam) continue;
      by.set(x.label, (by.get(x.label) ?? 0) + Math.min(r.endSec, x.endSec) - Math.max(r.startSec, x.startSec));
    }
    const span = r.endSec - r.startSec;
    // Fast alternating chords can leave a merged span that no one chord holds
    // for half of: say so ("?", unknown) rather than paint a chord that is not there.
    if (soundingSec(ctx, fam, r.startSec, r.endSec) < span * MIN_SOUNDING_SHARE) {
      r.label = 'X';
      continue;
    }
    let best: string | null = null;
    for (const [l, s] of Array.from(by)) if (s > span * 0.5 && (best === null || s > (by.get(best) ?? 0))) best = l;
    r.label = best ?? triadLabel(fam);
  }
}

/** The Harte label of a family's plain triad: "C:maj" -> "C", "E:min" -> "E:min". */
function triadLabel(fam: string): string {
  const [root, tri] = fam.split(':');
  return tri === 'maj' ? root : `${root}:${tri === 'sus4' ? 'sus4' : tri}`;
}

/** Chord changes per minute: adjacent chords with different names, over the span covered. */
export function changesPerMinute(runs: readonly ChordSpan[]): number {
  if (runs.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i].label !== runs[i - 1].label) n++;
  const span = runs[runs.length - 1].endSec - runs[0].startSec;
  return span > 0 ? (n / span) * 60 : 0;
}

/**
 * How many shown chords sound (same root and triad detected) for less than
 * half of their span. The honesty check for Simple; 0 on the demo songs.
 */
export function underHalfSounding(raw: readonly ChordSpan[], shown: readonly ChordSpan[]): number {
  const ctx: Ctx = { raw: raw.slice().sort((a, b) => a.startSec - b.startSec) };
  let n = 0;
  for (const r of shown) {
    if (!isChord(r.label)) continue;
    const span = r.endSec - r.startSec;
    if (span > 0 && soundingSec(ctx, chordFamily(r.label), r.startSec, r.endSec) < span * MIN_SOUNDING_SHARE) n++;
  }
  return n;
}
