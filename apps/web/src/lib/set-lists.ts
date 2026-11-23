// Set lists (#322; Phase B, B2): the rules every layer shares. CLIENT-SAFE: no I/O, no
// server imports, so the /sets pages, the player's "Next song ›" and the routes all read
// the same constants and the same decisions. The SQL lives in lib/set-lists-server.ts.
//
// Free, Pro and Studio alike (US AC 1.9, 5.6, 5.7): nothing here, and no set-list route,
// looks at the plan (test/set-lists-routes.test.mjs greps for it).
import { DEMO_SONGS } from './demo-catalog.ts';

/** At most this many lists per account (#322). */
export const MAX_SET_LISTS = 50;
/** At most this many songs in one list (#322). */
export const MAX_SET_LIST_SONGS = 200;
/** Names are 1-60 characters after trimming (migration 044 set_lists_name_shape). */
export const SET_LIST_NAME_MAX = 60;

/** The id the code-defined Demo set answers to: /sets/demo, /api/set-lists/demo, ?set=demo. */
export const DEMO_SET_ID = 'demo';
export const DEMO_SET_NAME = 'Demo set';
/**
 * The Demo set (brief D-c): defined in code, in #322's order. It resolves ONLY among
 * `is_demo` rows (lib/demo-songs.ts), has no database row, and no route can write it.
 */
export const DEMO_SET_SLUGS: readonly string[] = ['im-asking-you', 'offline', 'lucky-ticket'];
export const DEMO_SET = Object.freeze(
  DEMO_SET_SLUGS.map((slug) => {
    const song = DEMO_SONGS.find((d) => d.slug === slug);
    if (!song) throw new Error(`DEMO_SET: ${slug} is not in DEMO_SONGS`);
    return song;
  }),
);

/** The one sentence the list page and the delete confirm both say (AC 3). */
export const DELETE_LIST_NOTE = 'Deleting a list never deletes songs.';

/** Where an item stands right now (resolved at read time, never stored). */
export type SetListItemState = 'ready' | 'processing' | 'expired' | 'unavailable';
export type SetListItemSource = 'link' | 'upload' | 'demo';

/** One item as GET /api/set-lists/:id and /demo return it. */
export type SetListItem = {
  /** set_list_songs.item_id (a demo-set item: its catalog slug). */
  item_id: string;
  position: number;
  source: SetListItemSource;
  title: string;
  state: SetListItemState;
  /** The job that plays now (null unless state is ready or processing). */
  job_id: string | null;
};

/** A list with its items. `is_demo` marks the read-only, code-defined Demo set. */
export type SetListDetail = {
  id: string;
  name: string;
  is_demo: boolean;
  items: SetListItem[];
};

/** One row of GET /api/set-lists. `has_job` only when the request named ?job=<id>. */
export type SetListSummary = {
  id: string;
  name: string;
  song_count: number;
  updated_at: string;
  has_job?: boolean;
};

/** The short status a row shows next to its title (null = playable, nothing to say). */
export function itemStateLabel(state: SetListItemState): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'processing':
      return 'Processing';
    case 'expired':
      return 'Audio expired';
    case 'unavailable':
      return 'Unavailable';
  }
}

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

/** Trim and validate a list name (1-60 characters, no control characters). */
export function checkSetListName(raw: unknown): NameCheck {
  if (typeof raw !== 'string') return { ok: false, message: 'Give the list a name.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { ok: false, message: 'Give the list a name.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: 'That name has characters we cannot store.' };
  // Code points, as Postgres char_length counts them.
  if (Array.from(name).length > SET_LIST_NAME_MAX) {
    return { ok: false, message: `Names are at most ${SET_LIST_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}

/** The case-insensitive key two names collide on (the DB index is lower(name)). */
export const nameKey = (name: string): string => name.toLowerCase();

/** The name a new list is prefilled with: the first free "Set list N" (AC 7). */
export function defaultSetListName(existing: readonly string[]): string {
  const taken = new Set(existing.map(nameKey));
  for (let n = 1; ; n += 1) {
    const candidate = `Set list ${n}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/** May one more list be created when the account already has `count`? */
export const canAddList = (count: number): boolean => count < MAX_SET_LISTS;
/** May one more song go into a list that already holds `count`? */
export const canAddSong = (count: number): boolean => count < MAX_SET_LIST_SONGS;

/** Where "Next song ›" goes from the song playing now (AC 7). */
export type NextInSet = {
  /** The next playable item after the current one, or null at the end of the list. */
  next: SetListItem | null;
  /** How many items after the current one were skipped (expired, unavailable, processing). */
  skipped: number;
  /** 0-based index of the current song in the list, -1 when it is not in it. */
  index: number;
};

/**
 * From the job playing now, the next item that can play. Items that are not `ready` are
 * skipped and counted, so the player can say so in one line. Never wraps past the end.
 */
export function nextInSet(items: readonly SetListItem[], currentJobId: string): NextInSet {
  const index = items.findIndex((it) => it.job_id === currentJobId);
  if (index < 0) return { next: null, skipped: 0, index };
  let skipped = 0;
  for (let i = index + 1; i < items.length; i += 1) {
    const it = items[i];
    if (it.state === 'ready' && it.job_id) return { next: it, skipped, index };
    skipped += 1;
  }
  return { next: null, skipped, index };
}

/** The one-line notice for skipped items ('' when none were skipped). */
export function skippedNotice(skipped: number): string {
  if (skipped <= 0) return '';
  return skipped === 1 ? 'Skipped 1 song that can’t play now.' : `Skipped ${skipped} songs that can’t play now.`;
}

/** The player URL for an item played from a list (keeps ?set= so "Next song ›" shows). */
export function playHref(jobId: string, setId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}?set=${encodeURIComponent(setId)}`;
}

/** The list page for a set id. */
export function setHref(setId: string): string {
  return `/sets/${encodeURIComponent(setId)}`;
}

/** The order after moving item `i` by `delta` (-1 up, +1 down); the same order at an edge. */
export function moveItem<T>(order: readonly T[], i: number, delta: -1 | 1): T[] {
  const j = i + delta;
  const out = [...order];
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * The order after taking item `from` out and putting it back at index `to` (drag to reorder,
 * B2 follow-up). Every other item keeps its relative order. Either index out of range, or
 * `from === to`: the same order, copied.
 */
export function reorderItem<T>(order: readonly T[], from: number, to: number): T[] {
  const out = [...order];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return out;
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/**
 * Where a dragged row lands. `mids` are the vertical centres of the rows as laid out when the
 * drag began (index order), `from` is the dragged row and `y` is where its centre is now. The
 * row lands after every OTHER row whose centre it has passed, so it moves one place as soon
 * as its centre crosses a neighbour's. Always in 0..mids.length - 1.
 */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  if (mids.length === 0) return 0;
  let to = 0;
  for (let i = 0; i < mids.length; i += 1) {
    if (i === from) continue;
    if (y > mids[i]) to += 1;
  }
  return Math.min(to, mids.length - 1);
}

// ---- auto-scroll while dragging (#343) -----------------------------------------------------

/** How close (px) to the top or bottom of the viewport the pointer must be to scroll the page. */
export const EDGE_ZONE_PX = 48;
/**
 * Fastest auto-scroll, in px per SECOND, reached at the very edge of the viewport. Time-based
 * (#355 F2): a 120Hz phone scrolls exactly as fast as a 60Hz one (was 18px per frame).
 */
export const EDGE_MAX_SPEED_PX_PER_S = 1080;
/** The frame length assumed for the first frame of a drag, before there is a previous frame. */
export const NOMINAL_FRAME_MS = 1000 / 60;
/** A longer gap between frames (a stalled or backgrounded tab) counts as this long, no more. */
export const MAX_FRAME_DT_MS = 50;
/**
 * The pointer must move this far (px) from where the drag began before edge auto-scroll can
 * start (#355 F1): a drag that begins inside an edge zone does not scroll the page at once.
 */
export const AUTOSCROLL_ARM_PX = 8;
/** Reduced motion: no animated scroll; the page jumps this far per step while over an edge. */
export const REDUCED_JUMP_PX = 160;
/** Reduced motion: at most one jump per this many ms while the pointer stays over an edge. */
export const REDUCED_JUMP_INTERVAL_MS = 450;

/**
 * Auto-scroll speed (px per second) for a pointer at `clientY` in a viewport `viewportH` tall:
 * negative near the top (scroll up), positive near the bottom (scroll down), 0 elsewhere. The
 * speed grows with depth into the edge zone, up to `max` at (or past) the edge.
 *
 * `insetBottom` is the bottom safe area (env(safe-area-inset-bottom), the iOS home indicator,
 * #355 F4): the bottom zone sits above it, and a pointer inside the inset counts as past the
 * edge. On a viewport shorter than two zones each zone is half of what is left (M7).
 */
export function edgeScrollSpeed(
  clientY: number,
  viewportH: number,
  zone = EDGE_ZONE_PX,
  max = EDGE_MAX_SPEED_PX_PER_S,
  insetBottom = 0,
): number {
  if (!Number.isFinite(clientY) || !(viewportH > 0) || !(zone > 0)) return 0;
  const inset = Number.isFinite(insetBottom) && insetBottom > 0 ? insetBottom : 0;
  const usable = viewportH - inset;
  if (!(usable > 0)) return 0;
  const z = Math.min(zone, usable / 2);
  if (clientY < z) return -max * Math.min(1, (z - clientY) / z);
  const fromBottom = usable - clientY;
  if (fromBottom < z) return max * Math.min(1, (z - fromBottom) / z);
  return 0;
}

/** True once the pointer has moved at least `threshold` px (either way) from the drag start. */
export function autoScrollArmed(clientY: number, startY: number, threshold = AUTOSCROLL_ARM_PX): boolean {
  return Number.isFinite(clientY) && Number.isFinite(startY) && Math.abs(clientY - startY) >= threshold;
}

/**
 * Milliseconds this frame stands for: `now - lastFrameAt`, clamped to 0..MAX_FRAME_DT_MS, or
 * NOMINAL_FRAME_MS on the first frame (`lastFrameAt` null) or for a nonsense timestamp.
 */
export function frameDt(now: number, lastFrameAt: number | null): number {
  if (lastFrameAt === null || !Number.isFinite(now) || !Number.isFinite(lastFrameAt)) return NOMINAL_FRAME_MS;
  return Math.min(MAX_FRAME_DT_MS, Math.max(0, now - lastFrameAt));
}

/**
 * How far to scroll the page on this frame of a drag (px, may be fractional). Nothing until the
 * drag is `armed` (AUTOSCROLL_ARM_PX). Full motion: `edgeScrollSpeed` times this frame's
 * length (`frameDt`). Reduced motion: no animated scroll, a fixed jump of `REDUCED_JUMP_PX` in
 * the edge's direction, at most once per `REDUCED_JUMP_INTERVAL_MS` (`lastJumpAt` is the time
 * of the previous jump, or null if none yet while over this edge).
 */
export function autoScrollStep(opts: {
  clientY: number;
  viewportH: number;
  reduced: boolean;
  now: number;
  lastJumpAt: number | null;
  /** The previous frame's timestamp, null on the first frame. */
  lastFrameAt?: number | null;
  /** Bottom safe-area inset (px). */
  insetBottom?: number;
  /** False until the pointer has moved AUTOSCROLL_ARM_PX from the drag start. */
  armed?: boolean;
}): number {
  if (opts.armed === false) return 0;
  const speed = edgeScrollSpeed(opts.clientY, opts.viewportH, EDGE_ZONE_PX, EDGE_MAX_SPEED_PX_PER_S, opts.insetBottom ?? 0);
  if (speed === 0) return 0;
  if (!opts.reduced) return (speed * frameDt(opts.now, opts.lastFrameAt ?? null)) / 1000;
  if (opts.lastJumpAt !== null && opts.now - opts.lastJumpAt < REDUCED_JUMP_INTERVAL_MS) return 0;
  return Math.sign(speed) * REDUCED_JUMP_PX;
}

/**
 * Split an accumulated scroll amount into the whole pixels to scroll now and the fraction to
 * carry to the next frame (toward zero, so slow speeds still add up instead of rounding away).
 */
export function splitWholePx(total: number): { px: number; carry: number } {
  if (!Number.isFinite(total)) return { px: 0, carry: 0 };
  // A hair of tolerance so 0.3 + 0.3 + ... lands on 3, not 2.9999999.
  const px = Math.trunc(total + Math.sign(total) * 1e-9);
  return { px: px === 0 ? 0 : px, carry: px === 0 ? total : total - px };
}

/** A CSS length in px ("34px", "0", "") as a number; 0 for anything else or negative. */
export function parsePx(value: string | null | undefined): number {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * How far the dragged row has moved within the list since the drag began, counting page
 * scroll: the pointer's movement on screen plus how far the page has scrolled. Without the
 * scroll term a wheel or auto-scroll mid-drag leaves the row behind the pointer (#343).
 */
export function dragDelta(clientY: number, startY: number, scrollY: number, startScrollY: number): number {
  return clientY - startY + (scrollY - startScrollY);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A well-formed uuid (route params and bodies are checked before any query). */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A `?set=` value worth acting on: the Demo set, or a list id. */
export const isSetId = (v: unknown): v is string => v === DEMO_SET_ID || isUuid(v);
