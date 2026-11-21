// Simple / Detailed chords (Phase A, D6): which chord view the player shows,
// remembered per browser. "Simple" (the default) merges chords shorter than a
// beat and puts changes on the beat (lib/play/simplify-chords.ts); "Detailed"
// shows the chord data as it was detected. Display only: the stored chords are
// never changed. Storage is best-effort (private mode, a full or blocked
// localStorage): a failure means the default, never an error.

export type ChordMode = 'simple' | 'detailed';
export const DEFAULT_CHORD_MODE: ChordMode = 'simple';
export const CHORD_MODE_KEY = 'sl.play.chordMode.v1';

export function readChordMode(): ChordMode {
  try {
    const v = globalThis.localStorage?.getItem(CHORD_MODE_KEY);
    return v === 'detailed' || v === 'simple' ? v : DEFAULT_CHORD_MODE;
  } catch {
    return DEFAULT_CHORD_MODE;
  }
}

export function writeChordMode(mode: ChordMode): void {
  try {
    globalThis.localStorage?.setItem(CHORD_MODE_KEY, mode);
  } catch {
    /* not remembered: the choice still holds for this page */
  }
}
