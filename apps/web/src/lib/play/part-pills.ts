// "My part" stem pills on the play screen (Phase A D5, Jon 2026-11-21).
// Pure: no DOM, no engine. Pinned by test/play-part-pills.test.mjs.
//
// Jon's story: "easily lower the guitar level so I can listen just to the
// guitar as I play along". Lowering AND soloing are each ONE tap/hold from the
// play screen, which stays in view while mixing:
//
//   * a tap steps a stem 100% -> 30% -> muted -> 100%;
//   * a long-press (or S on the keyboard) solos it; again un-solos it.
//
// Everything here is a description of engine calls. The pills go through the
// same onGain / onMute / onSolo the Mixer uses, which only move a persistent
// GainNode's AudioParam (engine.ts, invariant 2): no restart, no reseek, no
// click. The Mixer (kept mounted in the Mix sheet, or the desktop column)
// writes the result to the per-job sessionStorage memory (Story 2.7), so the
// pills need no storage of their own.

import type { StemName, StemState } from './types';

/** The pills, in Jon's order: Guitar · Bass · Keys · Drums · Vocals (+ Other). */
export const PILL_STEMS: readonly StemName[] = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'other'];

/** The middle step of the tap cycle. */
export const LOW_GAIN = 0.3;

/** The visible name on a pill (narrow: six pills share a 328px row at 360). */
export const PILL_SHORT: Readonly<Record<StemName, string>> = Object.freeze({
  guitar: 'Gtr',
  bass: 'Bass',
  keys: 'Keys',
  drums: 'Drums',
  vocals: 'Vox',
  other: 'Other',
});

/** The spoken name. */
export const pillName = (stem: StemName): string => stem.charAt(0).toUpperCase() + stem.slice(1);

/** How to use the pills, said once for the whole row (the fieldset legend). */
export const PILLS_HOW = 'Parts. Tap a part to step it 100%, 30%, muted. Hold it, or press S, to solo it.';

export type PillLevel = 'full' | 'partial' | 'muted';

export interface PillView {
  readonly stem: StemName;
  readonly available: boolean;
  readonly level: PillLevel;
  /** Whole percent, 0..100 (the stem's own level, whether or not it is muted). */
  readonly percent: number;
  /** Soloed and audible. */
  readonly solo: boolean;
  /** Quiet only because another stem is soloed. */
  readonly silentBySolo: boolean;
  /** Pressed = changed from the full song (aria-pressed and the selected style). */
  readonly pressed: boolean;
  /** The second line on the pill: "100%", "30%", "muted", "solo", "silent", "n/a". */
  readonly state: string;
  /** The accessible name, stating the level ("Guitar, 30%"). */
  readonly ariaLabel: string;
}

const percentOf = (gain: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(gain) ? gain : 0)) * 100);

/** One pill's view of a stem. `anySolo`: is any stem soloed (silencing the rest)? */
export function pillView(stem: StemState, anySolo: boolean): PillView {
  const available = stem.availability === 'ready';
  const percent = percentOf(stem.gain);
  const level: PillLevel = stem.muted ? 'muted' : percent >= 100 ? 'full' : 'partial';
  const solo = available && stem.soloed && !stem.muted;
  const silentBySolo = available && anySolo && !stem.soloed && !stem.muted;
  const name = pillName(stem.name);
  if (!available) {
    return { stem: stem.name, available, level, percent, solo: false, silentBySolo: false, pressed: false, state: 'n/a', ariaLabel: `${name}, not available` };
  }
  const levelText = level === 'muted' ? 'muted' : `${percent}%`;
  const state = solo ? 'solo' : silentBySolo ? 'silent' : levelText;
  const ariaLabel = solo
    ? `${name}, solo${level === 'full' ? '' : `, ${levelText}`}`
    : silentBySolo
      ? `${name}, ${levelText}, silent while another part is soloed`
      : `${name}, ${levelText}`;
  return { stem: stem.name, available, level, percent, solo, silentBySolo, pressed: solo || level !== 'full', state, ariaLabel };
}

export interface PillOp {
  readonly stem: StemName;
  readonly gain?: number;
  readonly muted?: boolean;
  readonly soloed?: boolean;
}

/**
 * A tap: 100% -> 30% -> muted -> 100%. A level set on the fader in between
 * (say 55%) counts as lowered, so the next tap mutes. Unmuting goes back to
 * 100%, so three taps always come home to the full song for that stem.
 */
export function tapOps(stem: StemState): PillOp[] {
  if (stem.availability !== 'ready') return [];
  if (stem.muted) {
    const ops: PillOp[] = [];
    // Level first, so the unmute ramps straight to 100% and never via 30%.
    if (percentOf(stem.gain) < 100) ops.push({ stem: stem.name, gain: 1 });
    ops.push({ stem: stem.name, muted: false });
    return ops;
  }
  if (percentOf(stem.gain) >= 100) return [{ stem: stem.name, gain: LOW_GAIN }];
  return [{ stem: stem.name, muted: true }];
}

/**
 * A long-press (or S): solo the stem, or un-solo it if it is soloed. Soloing a
 * muted stem unmutes it, because "listen just to the guitar" with the guitar
 * muted is silence. Other solos are left alone (more than one stem can be
 * soloed, as in the Mixer).
 */
export function longPressOps(stem: StemState): PillOp[] {
  if (stem.availability !== 'ready') return [];
  if (stem.soloed) return [{ stem: stem.name, soloed: false }];
  const ops: PillOp[] = [{ stem: stem.name, soloed: true }];
  if (stem.muted) ops.push({ stem: stem.name, muted: false });
  return ops;
}

/**
 * The pills to show: the five named parts always (a missing or failed one is
 * shown disabled), plus Other only when the snapshot carries it.
 */
export function pillStems(stems: readonly StemState[]): StemState[] {
  const byName = new Map<StemName, StemState>();
  for (const s of stems ?? []) if (s && !byName.has(s.name)) byName.set(s.name, s);
  const out: StemState[] = [];
  for (const name of PILL_STEMS) {
    const s = byName.get(name);
    if (s) out.push(s);
    else if (name !== 'other') {
      out.push({ name, availability: 'unavailable', gain: 0, muted: false, soloed: false, effectivelySilent: false });
    }
  }
  return out;
}

/** The visible reason under the row when any pill is disabled, or null. */
export function unavailableNote(stems: readonly StemState[]): string | null {
  const off = stems.filter((s) => s.availability !== 'ready').map((s) => pillName(s.name));
  if (off.length === 0) return null;
  const list = off.length === 1 ? off[0] : `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}`;
  return `${list} ${off.length === 1 ? 'is' : 'are'} not available for this song.`;
}
