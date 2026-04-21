/**
 * Shared domain types — kept in one place so frontend + API agree.
 */

export type StemKind = "drums" | "bass" | "vocals" | "guitar" | "keys";

export const ALL_STEMS: StemKind[] = [
  "drums",
  "bass",
  "vocals",
  "guitar",
  "keys",
];

export const STEM_LABELS: Record<StemKind, string> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  guitar: "Guitar",
  keys: "Keys",
};

export const STEM_DESCRIPTIONS: Record<StemKind, string> = {
  drums: "Kicks, snares, hats, cymbals",
  bass: "Low-end, synth bass, bass guitar",
  vocals: "Lead, harmonies, ad-libs",
  guitar: "Electric, acoustic, leads",
  keys: "Piano, synths, organs, pads",
};

export type BarCount = 1 | 2 | 4 | 8;

export const BAR_OPTIONS: BarCount[] = [1, 2, 4, 8];

export type JobStatus =
  | "queued"
  | "downloading"
  | "separating"
  | "extracting"
  | "done"
  | "error";

export type JobRequest = {
  url: string;
  stems: StemKind[];
  bars: BarCount;
  loopsPerStem?: number; // default 5
};

export type Loop = {
  index: number; // 1..N
  filename: string;
  downloadUrl: string; // signed R2 URL, 24hr expiry
  durationSec: number;
  bpm: number;
  energyLabel: string; // "Quiet/Intro", "Peak Energy", ...
  startSec: number;
  endSec: number;
};

export type StemResult = {
  stem: StemKind;
  loops: Loop[];
};

export type Job = {
  id: string;
  createdAt: string;
  status: JobStatus;
  progress: number; // 0..100
  stage?: string;   // human-readable progress text
  url: string;
  title?: string;   // resolved YouTube title
  artist?: string;
  bpm?: number;
  bars: BarCount;
  stems: StemKind[];
  results?: StemResult[];
  error?: string;
  expiresAt?: string; // 24hr after completion
};
