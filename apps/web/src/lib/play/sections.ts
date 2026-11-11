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
 *   R6 touching segments with the same label merge; a gap or another label
 *      between them keeps two regions (two choruses are two regions)
 *   R7 output is sorted by startSec, non-overlapping, every region end > start
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
  const regions: { label: string; start: number; end: number }[] = [];
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

  return regions
    .map((r) => ({ startSec: round3(r.start), endSec: round3(r.end), label: r.label }))
    .filter((r) => r.endSec > r.startSec);
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

/** Click semantics: clicking the active region clears it, anything else selects it. */
export function nextLoop(active: LoopRegion | null, clicked: LoopRegion): LoopRegion | null {
  return sameRegion(active, clicked) ? null : clicked;
}

/** m:ss, floored. Bad input renders as 0:00 rather than "NaN:NaN". */
export function formatTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface NamedRegion { readonly region: LoopRegion; readonly name: string }

const titleCase = (s: string) => s.replace(/(^|\s)(\S)/g, (_m, sp: string, c: string) => sp + c.toUpperCase());

/** "Chorus 1", "Chorus 2" when a label repeats; plain "Verse" when it does not. */
export function nameRegions(regions: readonly LoopRegion[]): NamedRegion[] {
  const label = (r: LoopRegion) => normalizeLabel(r.label) || 'section';
  const total = new Map<string, number>();
  for (const r of regions) total.set(label(r), (total.get(label(r)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return regions.map((region) => {
    const l = label(region);
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return { region, name: (total.get(l) ?? 0) > 1 ? `${titleCase(l)} ${n}` : titleCase(l) };
  });
}
