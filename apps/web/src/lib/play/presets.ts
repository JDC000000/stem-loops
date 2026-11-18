// Practice presets for the Mix sheet (design v1.4, P1.3; DB-13 option (a)).
// Pure: no DOM, no engine. Pinned by test/play-presets.test.mjs.
//
//   * A preset SETS MUTES and leaves levels unchanged. It also clears every
//     solo, because a solo silences every other stem and would make the label
//     ("Full song", "No vocals") false.
//   * Which preset is pressed is DERIVED from the mix, never stored: the mix
//     matches a preset's mutes (and nothing is soloed) or it is "Custom". So
//     touching any mute, solo or slider that changes the mutes relabels the
//     selection "Custom" by construction, and the label can never disagree with
//     what is playing.
//   * Missing stems: a preset acts on the stems that exist. "Mute my part" is
//     disabled with a reason when the player's part is the missing stem.
//   * "Mute my part" asks "Which part do you play?" on its first tap (Guitar
//     pre-selected), then remembers the answer in localStorage.

import type { StemName, StemState } from './types';

export type PresetId = 'mine' | 'full' | 'novox' | 'db';

/** The parts a player can choose, in the order the question lists them. */
export const PARTS = ['guitar', 'bass', 'keys', 'drums', 'vocals'] as const;
export type Part = (typeof PARTS)[number];
export const DEFAULT_PART: Part = 'guitar';

export const PRESET_ORDER: readonly PresetId[] = ['mine', 'full', 'novox', 'db'];

export const PRESET_NAMES: Readonly<Record<PresetId, string>> = Object.freeze({
  mine: 'Mute my part',
  full: 'Full song',
  novox: 'No vocals',
  db: 'Drums + bass',
});

export const PART_QUESTION = 'Which part do you play?';

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const partLabel = (p: Part): string => titleCase(p);

/** The stems a preset mutes. Everything else is unmuted. */
export function presetMutes(id: PresetId, part: Part): ReadonlySet<StemName> {
  switch (id) {
    case 'mine':
      return new Set<StemName>([part]);
    case 'full':
      return new Set<StemName>();
    case 'novox':
      return new Set<StemName>(['vocals']);
    case 'db':
      return new Set<StemName>(['guitar', 'keys', 'vocals', 'other']);
  }
}

const present = (s: StemState) => s.availability === 'ready';

export interface PresetOp {
  readonly stem: StemName;
  readonly muted?: boolean;
  readonly soloed?: boolean;
}

/**
 * The engine calls that put `stems` into preset `id`. Only stems that exist
 * are touched, and only where they differ, so a preset that already holds is
 * a no-op.
 */
export function presetOps(id: PresetId, part: Part, stems: readonly StemState[]): PresetOp[] {
  const mutes = presetMutes(id, part);
  const ops: PresetOp[] = [];
  for (const s of stems) {
    if (!present(s)) continue;
    if (s.soloed) ops.push({ stem: s.name, soloed: false });
    const want = mutes.has(s.name);
    if (s.muted !== want) ops.push({ stem: s.name, muted: want });
  }
  return ops;
}

/**
 * Which preset the mix is in, or 'custom'. Compared over the stems that exist;
 * a solo anywhere is always custom. 'mine' is checked first, so a vocalist's
 * "Mute my part" reads as that and not as "No vocals".
 */
export function activePreset(stems: readonly StemState[], part: Part | null): PresetId | 'custom' {
  const live = stems.filter(present);
  if (live.length === 0) return 'full';
  if (live.some((s) => s.soloed)) return 'custom';
  const matches = (id: PresetId) => {
    const mutes = presetMutes(id, part ?? DEFAULT_PART);
    return live.every((s) => s.muted === mutes.has(s.name));
  };
  const order: PresetId[] = part ? ['mine', 'full', 'novox', 'db'] : ['full', 'novox', 'db'];
  for (const id of order) if (matches(id)) return id;
  return 'custom';
}

/** Why a preset cannot be used here, or null. Only "Mute my part" can be blocked. */
export function presetBlocked(id: PresetId, part: Part | null, stems: readonly StemState[]): string | null {
  if (id !== 'mine' || !part) return null;
  const s = stems.find((x) => x.name === part);
  if (s && present(s)) return null;
  return `${partLabel(part)} is not available for this song.`;
}

/** The small line under "Mix" on the transport: what the mix is doing now. */
export function mixStateLabel(stems: readonly StemState[], part: Part | null): string {
  const id = activePreset(stems, part);
  switch (id) {
    case 'mine':
      return `${part ?? DEFAULT_PART} off`;
    case 'full':
      return 'full song';
    case 'novox':
      return 'no vocals';
    case 'db':
      return 'drums + bass';
    default:
      return 'custom';
  }
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
