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

/** Long-press threshold: the same 500 ms as the section chips (design v1.4, P2.1). */
export const PILL_LONG_PRESS_MS = 500;
/** A finger that moves this far is not holding the pill. */
export const PILL_SLOP_PX = 10;
/** How long after a long-press is released its click may still arrive (as SectionLoop). */
export const PILL_SWALLOW_MS = 700;

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
export const PILLS_HOW =
  'Parts. Tap a part to step it 100%, 30%, muted. Hold it, or press S, to solo it. While a part is soloed, a tap ends the solo.';

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
const ready = (s: StemState) => s.availability === 'ready';

/** One pill's view of a stem. `anySolo`: is any stem soloed (silencing the rest)? */
export function pillView(stem: StemState, anySolo: boolean): PillView {
  const available = ready(stem);
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
  // While a solo is on, a tap ends it (tapOps): the label says so, and names
  // the level the part comes back at, so nothing changes out of sight.
  const ariaLabel = solo
    ? `${name}, solo${level === 'full' ? '' : `, ${levelText}`}. Tap to end the solo`
    : silentBySolo
      ? `${name}, silent while another part is soloed, back at ${levelText} when the solo ends. Tap to end the solo`
      : `${name}, ${levelText}`;
  return { stem: stem.name, available, level, percent, solo, silentBySolo, pressed: solo || level !== 'full', state, ariaLabel };
}

/**
 * One engine change for one stem. Applied as solo, then gain, then mute
 * (PartPills.run), so an unmute never ramps through an old level.
 */
export interface PillOp {
  readonly stem: StemName;
  readonly gain?: number;
  readonly muted?: boolean;
  readonly soloed?: boolean;
}

/** Can anything be heard in this mix? (engine.ts: silent = muted || (anySolo && !soloed)). */
export function audible(stems: readonly StemState[]): boolean {
  const live = stems.filter(ready);
  const anySolo = live.some((s) => s.soloed);
  return live.some((s) => !s.muted && percentOf(s.gain) > 0 && (!anySolo || s.soloed));
}

/** `stems` with `ops` applied, in order. Pure. */
export function applyOps(stems: readonly StemState[], ops: readonly PillOp[]): StemState[] {
  return stems.map((s) =>
    ops.filter((o) => o.stem === s.name && ready(s)).reduce<StemState>(
      (acc, o) => ({
        ...acc,
        ...(o.soloed !== undefined ? { soloed: o.soloed } : {}),
        ...(o.gain !== undefined ? { gain: o.gain } : {}),
        ...(o.muted !== undefined ? { muted: o.muted } : {}),
      }),
      s,
    ),
  );
}

/**
 * The safety net (review H1): a pill gesture never leaves the song silent. If
 * `ops` would, the stem that was touched comes back at 100%, unmuted, and every
 * solo ends instead, which is always audible.
 */
function neverSilent(stem: StemState, stems: readonly StemState[], ops: PillOp[]): PillOp[] {
  if (ops.length === 0 || audible(applyOps(stems, ops))) return ops;
  const out: PillOp[] = stems.filter((s) => ready(s) && s.soloed && s.name !== stem.name).map((s) => ({ stem: s.name, soloed: false }));
  out.push({
    stem: stem.name,
    ...(stem.soloed ? { soloed: false } : {}),
    ...(percentOf(stem.gain) < 100 ? { gain: 1 } : {}),
    ...(stem.muted ? { muted: false } : {}),
  });
  return out;
}

/**
 * A tap.
 *
 *   * With no solo on: 100% -> 30% -> muted -> 100%. A level set on the fader
 *     in between (say 55%) counts as lowered, so the next tap mutes. Unmuting
 *     goes back to 100% in ONE op (gain, then unmute), so three taps always come
 *     home and the unmute never ramps via 30%.
 *   * With a solo on, a tap ENDS THE SOLO and changes no level or mute (review
 *     H1/M2): on the soloed pill it un-solos that part; on a "silent" pill it
 *     ends every solo, so that part is heard again at the level it shows once
 *     the solo is gone. So nothing ever changes on a stem you cannot hear, and
 *     a soloed stem is never muted (which would silence everything).
 *   * Never total silence: muting the last audible part brings it back to 100%.
 */
export function tapOps(stem: StemState, stems: readonly StemState[] = [stem]): PillOp[] {
  if (!ready(stem)) return [];
  const soloed = stems.filter((s) => ready(s) && s.soloed);
  if (stem.soloed) return neverSilent(stem, stems, [{ stem: stem.name, soloed: false }]);
  if (soloed.length > 0) return neverSilent(stem, stems, soloed.map((s) => ({ stem: s.name, soloed: false })));
  let ops: PillOp[];
  if (stem.muted) ops = [percentOf(stem.gain) < 100 ? { stem: stem.name, gain: 1, muted: false } : { stem: stem.name, muted: false }];
  else if (percentOf(stem.gain) >= 100) ops = [{ stem: stem.name, gain: LOW_GAIN }];
  else ops = [{ stem: stem.name, muted: true }];
  return neverSilent(stem, stems, ops);
}

/**
 * A long-press (or S): solo the stem, or un-solo it if it is soloed. A solo is
 * "listen just to this part", so soloing also unmutes the part and brings it to
 * 100% (as "Solo my part" does). Other solos are left alone (more than one stem
 * can be soloed, as in the Mixer).
 */
export function longPressOps(stem: StemState, stems: readonly StemState[] = [stem]): PillOp[] {
  if (!ready(stem)) return [];
  if (stem.soloed) return neverSilent(stem, stems, [{ stem: stem.name, soloed: false }]);
  return [
    {
      stem: stem.name,
      soloed: true,
      ...(percentOf(stem.gain) < 100 ? { gain: 1 } : {}),
      ...(stem.muted ? { muted: false } : {}),
    },
  ];
}

/**
 * The pills to show: the five named parts always (a missing or failed one is
 * shown disabled), plus Other only when this song has an Other stem — that is,
 * the stem manifest offered one (availability 'ready', or 'encode_failed' when
 * it was produced but would not decode). The engine reports all six slots and
 * marks a stem the manifest never listed 'unavailable' ("never produced",
 * types.ts), so that is the one that hides Other (review L1).
 */
export function pillStems(stems: readonly StemState[]): StemState[] {
  const byName = new Map<StemName, StemState>();
  for (const s of stems ?? []) if (s && !byName.has(s.name)) byName.set(s.name, s);
  const out: StemState[] = [];
  for (const name of PILL_STEMS) {
    const s = byName.get(name);
    if (name === 'other') {
      if (s && s.availability !== 'unavailable') out.push(s);
      continue;
    }
    out.push(s ?? { name, availability: 'unavailable', gain: 0, muted: false, soloed: false, effectivelySilent: false });
  }
  return out;
}
