// Demo data for the landing's example (Lucky Ticket): loops.json + song-context.json +
// before-peaks.json, fetched from DEMO_ASSET_BASE. Schema documented in the prototype
// (documents/stem-loops-landing/prototype/CHANGELOG.md).
import { DEMO_BEFORE_PEAKS_URL, DEMO_DATA_BASE } from '@/lib/public-config';

export const STEM_ORDER = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'] as const;
export type StemName = (typeof STEM_ORDER)[number];
export const BAR_OPTIONS = [1, 2, 4, 8] as const;
export type SetKey = '1bar' | '2bar' | '4bar' | '8bar';
export const setKeyOf = (bars: number) => `${bars}bar` as SetKey;

type Flag = boolean | 'True' | 'False';
export interface DemoStem {
  name: string;
  file: string;
  silent?: Flag;
  faint?: Flag;
  peaks: number[];
}
export interface DemoSet {
  bars: number;
  duration_sec: number;
  duration_samples: number;
  sample_rate: number;
  before: { file: string };
  stems: DemoStem[];
}
export interface LoopsJson {
  pipeline: { bpm: number; measured_bpm?: number };
  sets: Record<SetKey, DemoSet>;
  stem_status_in_window?: Partial<Record<string, 'live' | 'silent' | 'faint'>>;
}
export interface SongContext {
  song: { duration_sec: number; peaks: number[] };
  loop: {
    start_sec: number;
    duration_sec: number;
    start_fraction: number;
    start_bar_index: number;
    nested_end_fraction: Record<SetKey, number>;
  };
  pipeline_grid: { bar_sec: number };
  measured_grid: { beat_times_sec: number[] };
  window_alignment: { drift_over_8bars_ms: number };
}
export interface DemoData {
  loops: LoopsJson;
  ctx: SongContext;
  before: Record<string, number[]> | null;
}

export const isTrue = (f: Flag | undefined) => f === true || f === 'True';

export async function loadDemoData(base = DEMO_DATA_BASE, beforeUrl = DEMO_BEFORE_PEAKS_URL): Promise<DemoData> {
  if (!base) throw new Error('NEXT_PUBLIC_DEMO_ASSET_BASE is not set');
  const get = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  };
  // before-peaks is optional (the A/B falls back to whole-song peaks)
  const [loops, ctx, before] = await Promise.all([
    get(`${base}loops.json`),
    get(`${base}song-context.json`),
    get(beforeUrl).catch(() => null),
  ]);
  return { loops, ctx, before };
}

export const stemOf = (d: DemoData, key: SetKey, n: string) => d.loops.sets[key].stems.find((s) => s.name === n);
export const stemStatus = (d: DemoData, n: string) => d.loops.stem_status_in_window?.[n] ?? 'live';
export const isSilentStem = (d: DemoData, n: string) => {
  const st = stemOf(d, '8bar', n);
  return !st || isTrue(st.silent) || stemStatus(d, n) === 'silent';
};
// loop length from the pipeline's sample count, never the mp3 container duration
export const loopLen = (d: DemoData, key: SetKey) => d.loops.sets[key].duration_samples / d.loops.sets[key].sample_rate;
export const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const startBar = (d: DemoData) => d.ctx.loop.start_bar_index + 1;
export const barRange = (d: DemoData, bars: number) =>
  bars === 1 ? String(startBar(d)) : `${startBar(d)}–${startBar(d) + bars - 1}`;
// Measured alignment of the v3 demo loop (demo-assets-v3/FINDINGS.md, vs an independent
// beat tracker): start +1.1 ms from a measured beat; drift per repeat −0.9 / −1.8 / −0.6 / −5.7 ms
// at 1 / 2 / 4 / 8 bars. That is noise-level and flips sign between loops, so the page states an
// upper bound per length, never an exact value and never zero. Bar 1 is NOT detected: this loop
// starts one beat before the bar line (beat 4 of the previous bar). Update with the demo set.
export const DEMO_ALIGNMENT = {
  startWithinMs: 1,
  driftBoundMs: { 1: 2, 2: 2, 4: 2, 8: 6 } as Record<number, number>,
};
export const driftBoundMs = (bars: number) => DEMO_ALIGNMENT.driftBoundMs[bars] ?? 6;
export const detectedBpm = (d: DemoData) => (+d.loops.pipeline.bpm).toFixed(1);

// Mirrored, filled min/max envelope (DAW-like), drawn in a 1000×40 box and stretched.
export function envPath(peaks: number[]): string {
  const W = 1000, M = 20, n = peaks.length;
  if (!n) return '';
  let top = `M0 ${M}`, bot = '';
  for (let i = 0; i < n; i++) {
    const a = Math.max(0.025, Math.min(1, peaks[i])) * (M - 0.5);
    const x = (((i + 0.5) / n) * W).toFixed(1);
    top += `L${x} ${(M - a).toFixed(2)}`;
    bot = `L${x} ${(M + a).toFixed(2)}${bot}`;
  }
  return `${top}L${W} ${M}${bot}Z`;
}
export const SILENT_PEAKS: number[] = new Array(180).fill(0);
