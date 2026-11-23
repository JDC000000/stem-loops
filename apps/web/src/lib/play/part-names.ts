/**
 * Custom part names, saved on THIS DEVICE ONLY (Phase C C3; Jon PC-1 + PC-3,
 * 2026-11-23). No account, no API route, no migration: localStorage, one entry
 * per job, so a name never leaks to another song or another device.
 *
 * Sections default to neutral names ("Part 1", "Part 2"; DR-D2, see
 * nameRegions in ./sections). A custom name REPLACES the default on the chip
 * and wherever the screen names a part; the start time is never part of it.
 *
 * Keyed by job id + the section's START SECOND (not its index): if the section
 * list is re-derived with a part added or dropped earlier in the song, a name
 * stays with the music it was typed for.
 *
 * Every storage call is wrapped: private mode, a full quota or a missing
 * `localStorage` (server render) just means "no custom names".
 */
import type { LoopRegion } from './types';

/** Longest custom name, in characters (after trimming). */
export const MAX_PART_NAME_LEN = 24;
/** One entry per job: `sl.play.partNames.v1:<jobId>` -> JSON `{ "<startSec>": "name" }`. */
export const PART_NAMES_KEY_PREFIX = 'sl.play.partNames.v1:';

export type PartNameMap = Readonly<Record<string, string>>;

/** The minimal Storage surface used here (so tests can pass a fake). */
export interface NameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const partNamesKey = (jobId: string): string => `${PART_NAMES_KEY_PREFIX}${jobId}`;

/** The map key for a section: its start, whole seconds. */
export const partNameSlot = (region: Pick<LoopRegion, 'startSec'>): string => String(Math.max(0, Math.round(region.startSec)));

/** Trim, collapse inner whitespace runs, cap at MAX_PART_NAME_LEN. "" = use the default. */
export function sanitizePartName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, MAX_PART_NAME_LEN).join('').trim();
}

function defaultStorage(): NameStorage | null {
  try {
    return (globalThis.localStorage as NameStorage | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The saved names for `jobId`; `{}` for nothing saved, bad JSON or no storage. */
export function readPartNames(jobId: string, storage: NameStorage | null = defaultStorage()): PartNameMap {
  if (!jobId || !storage) return {};
  try {
    const raw = storage.getItem(partNamesKey(jobId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const name = sanitizePartName(v);
      if (name) out[k] = name;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save `names` for `jobId` (empty entries dropped; an empty map removes the
 * key). Returns false when the browser refused, so the screen can say so.
 */
export function writePartNames(jobId: string, names: PartNameMap, storage: NameStorage | null = defaultStorage()): boolean {
  if (!jobId || !storage) return false;
  try {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(names)) {
      const name = sanitizePartName(v);
      if (name) clean[k] = name;
    }
    if (Object.keys(clean).length === 0) storage.removeItem(partNamesKey(jobId));
    else storage.setItem(partNamesKey(jobId), JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** Display names: the custom name where one is saved for that section's start, else the default. */
export function applyPartNames(defaults: readonly string[], regions: readonly LoopRegion[], custom: PartNameMap): string[] {
  return defaults.map((d, i) => {
    const r = regions[i];
    const c = r ? custom[partNameSlot(r)] : undefined;
    return c ? sanitizePartName(c) || d : d;
  });
}

/**
 * The map to save from the sheet's text fields: one entry per section whose
 * trimmed text is non-empty and not the default name (empty or default = back to default).
 */
export function collectPartNames(drafts: readonly string[], regions: readonly LoopRegion[], defaults: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  regions.forEach((r, i) => {
    const name = sanitizePartName(drafts[i] ?? '');
    if (name && name !== defaults[i]) out[partNameSlot(r)] = name;
  });
  return out;
}
