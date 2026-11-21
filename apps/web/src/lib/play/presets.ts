// Practice presets for the Mix sheet (design v1.4, P1.3; DB-13 option (a);
// Phase A D5, Jon 2026-11-21). Pure: no DOM, no engine. Pinned by
// test/play-presets.test.mjs.
//
//   * Three presets: "Mute my part", "Solo my part", "Full song" (D5: "No
//     vocals" and "Drums + bass" are gone).
//   * "Full song" puts every stem back: unmuted, unsoloed, at 100%. "Mute my
//     part" is the full song with your part muted. Since D5 the play screen's
//     part pills set LEVELS (100% -> 30% -> muted), so a preset that left levels
//     alone could read "Full song" while the guitar sat at 30%; the presets now
//     own levels too, which keeps the label true.
//   * "Solo my part" solos your part (unmuting it if needed) and clears any
//     other solo. It leaves the other stems' levels and mutes alone: they are
//     silent while the solo holds, and come back as they were when it is cleared.
//   * Which preset is pressed is DERIVED from the mix, never stored: the mix
//     matches a preset or it is "Custom". So touching any control afterwards
//     relabels the selection by construction, and the label can never disagree
//     with what is playing.
//   * Missing stems: a preset acts on the stems that exist. The part presets are
//     disabled with a reason when the player's part is the missing stem.
//   * The part presets ask "Which part do you play?" on their first tap (Guitar
//     pre-selected), then remember the answer in localStorage.

import type { StemName, StemState } from './types';

export type PresetId = 'mine' | 'solo' | 'full';

/** The parts a player can choose, in the order the question lists them. */
export const PARTS = ['guitar', 'bass', 'keys', 'drums', 'vocals'] as const;
export type Part = (typeof PARTS)[number];
export const DEFAULT_PART: Part = 'guitar';

export const PRESET_ORDER: readonly PresetId[] = ['mine', 'solo', 'full'];

export const PRESET_NAMES: Readonly<Record<PresetId, string>> = Object.freeze({
  mine: 'Mute my part',
  solo: 'Solo my part',
  full: 'Full song',
});

/** The verb on the confirm button after "Which part do you play?" ("Mute guitar"). */
export const PRESET_VERBS: Readonly<Record<'mine' | 'solo', string>> = Object.freeze({ mine: 'Mute', solo: 'Solo' });

/** True for the presets that act on the remembered part. */
export const isPartPreset = (id: PresetId): id is 'mine' | 'solo' => id === 'mine' || id === 'solo';

export const PART_QUESTION = 'Which part do you play?';

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const partLabel = (p: Part): string => titleCase(p);

const present = (s: StemState) => s.availability === 'ready';
/** Whole percent, the way the faders and pills show a level. */
const pct = (gain: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(gain) ? gain : 0)) * 100);
const full = (s: StemState) => pct(s.gain) >= 100;

export interface PresetOp {
  readonly stem: StemName;
  readonly gain?: number;
  readonly muted?: boolean;
  readonly soloed?: boolean;
}

/**
 * The engine calls that put `stems` into preset `id`. Only stems that exist
 * are touched, and only where they differ, so a preset that already holds is
 * a no-op. Within one stem the order is solo, gain, mute (PlayerScreen applies
 * them in that order).
 */
export function presetOps(id: PresetId, part: Part, stems: readonly StemState[]): PresetOp[] {
  const ops: PresetOp[] = [];
  for (const s of stems) {
    if (!present(s)) continue;
    if (id === 'solo') {
      const mine = s.name === part;
      if (s.soloed !== mine) ops.push({ stem: s.name, soloed: mine });
      if (mine && s.muted) ops.push({ stem: s.name, muted: false });
      continue;
    }
    if (s.soloed) ops.push({ stem: s.name, soloed: false });
    const mute = id === 'mine' && s.name === part;
    // The muted part keeps its level; it comes back at that level when unmuted.
    if (!mute && !full(s)) ops.push({ stem: s.name, gain: 1 });
    if (s.muted !== mute) ops.push({ stem: s.name, muted: mute });
  }
  return ops;
}

/**
 * Which preset the mix is in, or 'custom'. Compared over the stems that exist.
 * Without a remembered part only "Full song" can match.
 */
export function activePreset(stems: readonly StemState[], part: Part | null): PresetId | 'custom' {
  const live = stems.filter(present);
  if (live.length === 0) return 'full';
  const soloed = live.filter((s) => s.soloed);
  if (soloed.length > 0) {
    const only = soloed.length === 1 ? soloed[0] : null;
    return part && only && only.name === part && !only.muted ? 'solo' : 'custom';
  }
  if (live.every((s) => !s.muted && full(s))) return 'full';
  if (part && live.some((s) => s.name === part)) {
    const mine = live.every((s) => (s.name === part ? s.muted : !s.muted && full(s)));
    if (mine) return 'mine';
  }
  return 'custom';
}

/** Why a preset cannot be used here, or null. Only the part presets can be blocked. */
export function presetBlocked(id: PresetId, part: Part | null, stems: readonly StemState[]): string | null {
  if (!isPartPreset(id) || !part) return null;
  const s = stems.find((x) => x.name === part);
  if (s && present(s)) return null;
  return `${partLabel(part)} is not available for this song.`;
}

/**
 * The small line under "Mix" on the transport (D5): what the mix is doing, in
 * the user's words. "Full song" when nothing is changed; one changed stem names
 * itself ("Guitar 30%", "Guitar muted", "Guitar solo"); a single solo names
 * itself whatever the silent stems are set to; anything more is "Custom".
 */
export function mixStateLabel(stems: readonly StemState[]): string {
  const live = stems.filter(present);
  const soloed = live.filter((s) => s.soloed);
  if (soloed.length > 0) {
    return soloed.length === 1 && !soloed[0].muted ? `${titleCase(soloed[0].name)} solo` : 'Custom';
  }
  const changed = live.filter((s) => s.muted || !full(s));
  if (changed.length === 0) return 'Full song';
  if (changed.length > 1) return 'Custom';
  const s = changed[0];
  return s.muted ? `${titleCase(s.name)} muted` : `${titleCase(s.name)} ${pct(s.gain)}%`;
}

// ── the remembered part (localStorage; DB-13 (a)) ────────────────────────────

export const PART_STORAGE_KEY = 'sl.play.part.v1';

export function parsePart(raw: unknown): Part | null {
  return typeof raw === 'string' && (PARTS as readonly string[]).includes(raw) ? (raw as Part) : null;
}

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function store(scope: unknown): KV | null {
  try {
    const s = (scope as { localStorage?: KV } | null | undefined)?.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null; // Safari private mode, a sandboxed iframe, a blocked origin
  }
}

/** The remembered part, or null. Never throws. */
export function readPart(scope: unknown = globalThis): Part | null {
  try {
    return parsePart(store(scope)?.getItem(PART_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Remember the part. Storage failing is not worth an error: the answer just isn't kept. */
export function writePart(part: Part, scope: unknown = globalThis): void {
  try {
    store(scope)?.setItem(PART_STORAGE_KEY, part);
  } catch {
    /* quota, private mode */
  }
}
