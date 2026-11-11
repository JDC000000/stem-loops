/**
 * The loop PLAN: what `/loops` offers for a song, worked out before a single
 * byte of audio is touched.
 *
 * This module is pure — no DOM, no fetch, no AudioContext — and that is the
 * point. The `/loops` page renders its whole idle state from a plan: four
 * bar-length banks across six stems, each card showing the duration and the
 * file size the loop WOULD have. Nothing is decoded, sliced or encoded until
 * the viewer presses "Cut loops". The plan is what makes an honest idle state
 * possible without doing the work early.
 *
 * WHY BAR MATH AND NOT THE WORKER'S LOOP ROWS. The pipeline cuts loops at ONE
 * bar length per job (`jobs.loop_length_bars`, 4 by default) and at musically
 * chosen phrase starts. Three of the four banks this page offers therefore do
 * not exist in the `loops` table for any job and never will without a new
 * server capability. So the banks are derived from the song's own tempo, which
 * is what the design canvas shows (1 / 2 / 4 / 8 bars x 6 stems = 24 cards).
 */
import { PLAYABLE_STEMS, type StemName } from '@/lib/play/types';

/** The four banks, smallest first. This order is the order they render in. */
export const LOOP_BAR_BANKS = [1, 2, 4, 8] as const;
export type LoopBars = (typeof LOOP_BAR_BANKS)[number];

/**
 * 4/4 is assumed, exactly as the worker assumes it: `pipeline.encode_and_upload`
 * computes `bar = 4 * 60.0 / bpm` and `beat_grid` fits a 4-beat bar. A song in
 * 3/4 gets bars that are a third too long on both sides of the system, which is
 * a known limitation of the product and not of this module.
 */
export const BEATS_PER_BAR = 4;

/** 24-bit, to match the WAV the worker writes (`encoder/wav_encoder.encode_24bit`). */
export const LOOP_BIT_DEPTH = 24;

/** Canonical RIFF/WAVE header length for PCM with no extra chunks. */
export const WAV_HEADER_BYTES = 44;

/** Tempo outside this range is not a tempo; a plan built on it would be nonsense. */
export const MIN_BPM = 40;
export const MAX_BPM = 250;

/** Seconds in one bar at `bpm`. Throws on a tempo that is not usable. */
export function barSeconds(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new RangeError(`bpm out of range: ${bpm}`);
  }
  return (BEATS_PER_BAR * 60) / bpm;
}

/** Seconds in a `bars`-bar loop at `bpm`. */
export function loopSeconds(bpm: number, bars: number): number {
  return bars * barSeconds(bpm);
}

/** Bytes a PCM WAV of `frames` frames occupies, header included. */
export function wavByteLength(frames: number, channels: number, bitDepth: number): number {
  return WAV_HEADER_BYTES + frames * channels * (bitDepth / 8);
}

export interface LoopSpec {
  /** Stable within a plan; used as a React key and as the cut's cache key. */
  readonly id: string;
  readonly stem: StemName;
  readonly bars: LoopBars;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  /** Sample frames the cut will contain, at the plan's sample rate. */
  readonly frames: number;
  /** Size of the 24-bit WAV this spec will produce, header included. */
  readonly byteLength: number;
  readonly filename: string;
}

export interface PlanInput {
  readonly bpm: number;
  /** Where bar 1 begins, in seconds. See `downbeatAnchorSec`. */
  readonly anchorSec?: number;
  /** Track length. A bank whose loop does not fit inside the track is dropped. */
  readonly durationSec?: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Used in filenames only. */
  readonly title?: string | null;
  readonly musicalKey?: string | null;
  /** Defaults to all six playable stems, in mixer order. */
  readonly stems?: readonly StemName[];
}

/**
 * Filename slug: the worker's own rule (`pipeline._title_slug`) is lowercase,
 * alphanumerics and dashes, so a downloaded loop reads the same whichever side
 * cut it. Collapsed runs, trimmed ends, capped length, never empty.
 */
export function slug(raw: string | null | undefined, fallback = 'stem-loops'): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || fallback;
}

/**
 * Where bar 1 begins.
 *
 * The browser has no beat tracker, but it does not need one: the worker already
 * fitted a grid for this song and left its fingerprints in the `loops` rows it
 * wrote. Each row carries `start_sec` (a beat-anchored loop start) and
 * `start_bar` (which bar that was), so for any row
 *
 *     anchor = start_sec - start_bar * bar
 *
 * recovers the grid's origin. Rows disagree by a few milliseconds because the
 * worker snaps each start to the beat detected in its own window, so the MEDIAN
 * is taken rather than the first row, and a row whose implied anchor is not
 * inside [0, bar) is discarded as noise rather than allowed to drag the median.
 *
 * Returns 0 when there are no usable rows. That is the honest fallback: a song
 * with no loop rows has no grid to recover, and 0 means "start at the top of
 * the file", which is right for a track with no pickup and merely imprecise for
 * one that has.
 */
export function downbeatAnchorSec(
  rows: readonly { start_sec?: number | string | null; start_bar?: number | string | null }[] | null | undefined,
  bpm: number,
): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let bar: number;
  try {
    bar = barSeconds(bpm);
  } catch {
    return 0;
  }
  const candidates: number[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // Postgres `numeric` arrives as a STRING through node-pg even though the
    // generated type says `number` — the same coercion lib/play/sections.ts does.
    const start = Number(r.start_sec);
    const barIndex = Number(r.start_bar);
    if (!Number.isFinite(start) || !Number.isFinite(barIndex)) continue;
    const a = start - barIndex * bar;
    if (a >= 0 && a < bar) candidates.push(a);
  }
  if (candidates.length === 0) return 0;
  candidates.sort((x, y) => x - y);
  const mid = candidates.length >> 1;
  return candidates.length % 2 === 1
    ? candidates[mid]
    : (candidates[mid - 1] + candidates[mid]) / 2;
}

/**
 * Build the plan. One loop per (stem, bank), starting at the song's first
 * downbeat — the design canvas's 24 cards.
 *
 * A bank is dropped when the loop would run past the end of the track, so a
 * 90-second song at 60 BPM offers 1, 2 and 4 bars and simply does not offer 8.
 * Dropping it is better than offering a card that cuts short or silent audio.
 */
export function planLoops(input: PlanInput): LoopSpec[] {
  const bar = barSeconds(input.bpm);
  const anchor = Number.isFinite(input.anchorSec) ? Math.max(0, input.anchorSec as number) : 0;
  const stems = input.stems ?? PLAYABLE_STEMS;
  const { sampleRate, channels } = input;
  const titleSlug = slug(input.title);
  const keySlug = slug(input.musicalKey, 'unknown-key');
  const bpmLabel = Math.round(input.bpm);
  const limit = Number.isFinite(input.durationSec) && (input.durationSec as number) > 0
    ? (input.durationSec as number)
    : Infinity;

  const out: LoopSpec[] = [];
  for (const bars of LOOP_BAR_BANKS) {
    const durationSec = bars * bar;
    if (anchor + durationSec > limit) continue;
    const frames = Math.round(durationSec * sampleRate);
    const byteLength = wavByteLength(frames, channels, LOOP_BIT_DEPTH);
    for (const stem of stems) {
      out.push({
        id: `${stem}-${bars}`,
        stem,
        bars,
        startSec: anchor,
        endSec: anchor + durationSec,
        durationSec,
        frames,
        byteLength,
        filename: `${titleSlug}_${stem}_${bars}bar_${bpmLabel}bpm_${keySlug}.wav`,
      });
    }
  }
  return out;
}

/** Group a plan into its banks, in `LOOP_BAR_BANKS` order. Empty banks are omitted. */
export function banksOf(specs: readonly LoopSpec[]): { bars: LoopBars; specs: LoopSpec[] }[] {
  return LOOP_BAR_BANKS.map((bars) => ({ bars, specs: specs.filter((s) => s.bars === bars) })).filter(
    (b) => b.specs.length > 0,
  );
}

/** "8.00 s" / "0.75 s" — one label, used by the card and by nothing else. */
export function formatSeconds(sec: number): string {
  return `${sec.toFixed(2)} s`;
}

/** "2.0 MB" / "512 KB", decimal MB as a file manager reports it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}
