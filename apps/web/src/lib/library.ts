// The /history page's list: the signed-in user's LIBRARY (GET /api/library, from the
// database, owner-scoped on the server) merged with this browser's anonymous history
// (lib/history.ts, localStorage).
//
// Jon, 2026-11-15: Free = 24 hours. Pro and Studio = kept while subscribed, plus 30 days'
// grace after the subscription ends. Users build a LIBRARY of songs.
//
// Phase B, B1 (migration 043; US 1.8, 5.2-5.4): the library keeps every song. After its audio
// is deleted a song stays as an EXPIRED row (title, BPM · key, "Audio expired") with a Re-make
// (a link: one tap, uses one of your songs) or "Upload again" (an upload). Search on title
// (and artist, for the demo songs only); sort by Recent (last opened on this browser, else
// created) / Newest / A–Z.
//
// Pure and free of `@/` imports so src/lib/library.test.mjs can load it directly.
import { jobLabel, shortSource } from './job-label.ts';
import { RETENTION_MS } from './retention.ts';
import { songThumbnailUrl } from './song-thumb.ts';
import { demoForJobId } from './demo-catalog.ts';

/** One `songs` row of GET /api/library. `expires_at` is the song's real deletion time. */
export type LibraryRow = {
  id: string;
  title?: string | null;
  original_filename?: string | null;
  youtube_url?: string | null;
  /** Usually empty on recent rows (P5.1); the thumbnail falls back to youtube_url. */
  video_id?: string | null;
  bpm?: number | null;
  musical_key?: string | null;
  status?: string;
  created_at: string;
  expires_at: string;
  /** Demo song (migration 040): its expires_at is 2099-12-31; no "deleted in" is shown. */
  is_demo?: boolean;
};

/** One `entries` row of GET /api/library: a song whose audio is gone (migration 043). */
export type LibraryEntryRow = {
  entry_id: string;
  input_kind?: string | null;
  youtube_url?: string | null;
  original_filename?: string | null;
  title?: string | null;
  video_id?: string | null;
  bpm?: number | null;
  musical_key?: string | null;
  created_at: string;
};

/** A browser-history entry (lib/history.ts HistoryEntry). */
export type BrowserEntry = { id: string; at: number };

export type SongState = 'ready' | 'processing' | 'failed' | 'expired' | 'unknown';

export type ListedSong = {
  /** Unique per row (a job id, or `entry:<entry id>`). */
  key: string;
  /** The job id, or null for an expired entry (it has no job). */
  id: string | null;
  /** The library entry id: what Re-make and Remove take. Expired rows only. */
  entryId: string | null;
  label: string;
  /** "102 BPM · A major", or whichever half is known; null when neither is. */
  meta: string | null;
  createdAtMs: number;
  /** When it is deleted. Library: the server's deadline. Browser-only: at + 24 h. Expired: null. */
  expiresAtMs: number | null;
  source: 'library' | 'browser' | 'entry';
  /** A demo song: the list shows no "deleted in" for it. Library rows only. */
  isDemo: boolean;
  /** i.ytimg.com thumbnail for a linked song (P5.1), else null. */
  thumbUrl: string | null;
  /**
   * What the row can do (QA A-06): 'ready' plays, 'processing' is on its way,
   * 'failed' never plays (the list shows a status chip and no thumbnail), 'expired' has no
   * audio left (Re-make or Upload again). 'unknown' for a browser-only entry.
   */
  state: SongState;
  /** An expired upload: offers "Upload again", never Re-make. */
  isUpload: boolean;
  /** Lower-cased, accent-folded text that search matches (title; + artist for a demo song). */
  searchText: string;
};

/** jobs.status (TSD §6.3) -> what the list says about the row. */
export function songState(status: string | null | undefined): SongState {
  if (status === 'done') return 'ready';
  if (status === 'failed') return 'failed';
  if (typeof status === 'string' && status) return 'processing';
  return 'unknown';
}

/** The chip a row carries, or null for a playable (or unknown) one. */
export function stateChip(state: SongState): string | null {
  if (state === 'failed') return 'Failed';
  if (state === 'processing') return 'Processing';
  if (state === 'expired') return AUDIO_EXPIRED;
  return null;
}

/** "102 BPM · A major". BPM is rounded; either half may be missing. */
export function bpmKey(bpm: number | null | undefined, key: string | null | undefined): string | null {
  const b = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? `${Math.round(bpm)} BPM` : null;
  const k = typeof key === 'string' && key.trim() ? key.trim() : null;
  return b && k ? `${b} · ${k}` : b ?? k;
}

/** Search normal form: lower case, accents and curly quotes folded, spaces collapsed. */
export function searchFold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ms = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const titleOf = (r: { title?: string | null; original_filename?: string | null; youtube_url?: string | null; id: string }) =>
  // A link with no title yet is listed by its short host/ID form, not the raw URL (QA A-06).
  r.title?.trim() || r.original_filename?.trim() ? jobLabel(r) : r.youtube_url?.trim() ? shortSource(r.youtube_url) : jobLabel(r);

/**
 * Library songs (server deadline, human label) first-class; expired entries (no audio) next;
 * browser-only entries kept with Free's 24 h clock (they are anonymous jobs, or not this
 * account's). A browser entry for an id the library also has is dropped: the library row is
 * the truth. Expired JOB rows are left out (their entry, if any, is the row). Newest first.
 */
export function listedSongs(
  library: readonly LibraryRow[] | null,
  browser: readonly BrowserEntry[],
  nowMs: number = Date.now(),
  entries: readonly LibraryEntryRow[] = [],
): ListedSong[] {
  const out = new Map<string, ListedSong>();
  for (const r of library ?? []) {
    const createdAtMs = ms(r.created_at);
    const expiresAtMs = ms(r.expires_at);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    const state = songState(r.status);
    const label = titleOf(r);
    const isDemo = r.is_demo === true;
    const demo = isDemo ? demoForJobId(r.id) : null;
    out.set(r.id, {
      key: r.id, id: r.id, entryId: null, label, meta: bpmKey(r.bpm, r.musical_key), createdAtMs, expiresAtMs,
      source: 'library', isDemo,
      // A failed song shows no video still: nothing about the row may look playable.
      thumbUrl: state === 'failed' ? null : songThumbnailUrl(r),
      state, isUpload: false,
      searchText: searchFold(demo ? `${label} ${demo.artist}` : label),
    });
  }
  for (const e of entries) {
    const createdAtMs = ms(e.created_at);
    if (!Number.isFinite(createdAtMs) || !e.entry_id) continue;
    const label = titleOf({ ...e, id: e.youtube_url ?? 'Your song' });
    const key = `entry:${e.entry_id}`;
    out.set(key, {
      key, id: null, entryId: e.entry_id, label, meta: bpmKey(e.bpm, e.musical_key), createdAtMs, expiresAtMs: null,
      source: 'entry', isDemo: false, thumbUrl: songThumbnailUrl(e), state: 'expired',
      isUpload: !e.youtube_url, searchText: searchFold(label),
    });
  }
  for (const b of browser) {
    if (out.has(b.id)) continue;
    const expiresAtMs = b.at + RETENTION_MS;
    if (expiresAtMs <= nowMs) continue;
    out.set(b.id, {
      key: b.id, id: b.id, entryId: null, label: b.id, meta: null, createdAtMs: b.at, expiresAtMs, source: 'browser',
      isDemo: false, thumbUrl: null, state: 'unknown', isUpload: false, searchText: searchFold(b.id),
    });
  }
  return Array.from(out.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** Songs whose title (or a demo song's artist) contains every word of `query`. */
export function filterSongs(songs: readonly ListedSong[], query: string): ListedSong[] {
  const words = searchFold(query).split(' ').filter(Boolean);
  if (!words.length) return songs.slice();
  return songs.filter((s) => words.every((w) => s.searchText.includes(w)));
}

export type SortMode = 'recent' | 'newest' | 'az';
export const SORT_LABELS: Readonly<Record<SortMode, string>> = { recent: 'Recent', newest: 'Newest', az: 'A–Z' };

/**
 * Recent: by when the song was last OPENED on this browser (the /jobs/[id] marker), falling
 * back to when it was made, newest first. Newest: by when it was made. A–Z: by title.
 * Expired rows have no job id, so for them Recent is when they were made.
 */
export function sortSongs(songs: readonly ListedSong[], mode: SortMode, lastOpened: Readonly<Record<string, number>> = {}): ListedSong[] {
  const out = songs.slice();
  if (mode === 'az') return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || b.createdAtMs - a.createdAtMs);
  if (mode === 'newest') return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const at = (s: ListedSong) => {
    const opened = s.id ? lastOpened[s.id] : undefined;
    return typeof opened === 'number' && Number.isFinite(opened) ? Math.max(opened, s.createdAtMs) : s.createdAtMs;
  };
  return out.sort((a, b) => at(b) - at(a) || b.createdAtMs - a.createdAtMs);
}

// ── last opened (localStorage; written by components/library/LastOpenedMarker) ──
export const LAST_OPENED_KEY = 'sl-last-opened';
const LAST_OPENED_MAX = 200;

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function readLastOpened(store: KV | null | undefined): Record<string, number> {
  try {
    const raw = store?.getItem(LAST_OPENED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

/** Record that job `id` was opened at `nowMs`; keeps the newest LAST_OPENED_MAX ids. */
export function recordLastOpened(store: KV | null | undefined, id: string, nowMs: number = Date.now()): void {
  if (!store || !/^[0-9a-f-]{36}$/i.test(id)) return;
  try {
    const m = readLastOpened(store);
    m[id] = nowMs;
    const kept = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, LAST_OPENED_MAX);
    store.setItem(LAST_OPENED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or blocked: Recent falls back to created_at.
  }
}

/** Copy (Phase B, B1). */
export const AUDIO_EXPIRED = 'Audio expired';
export const REMAKE_LABEL = 'Re-make · uses 1 of your songs';
export const REMAKE_BUSY_LABEL = 'Re-making…';
export const UPLOAD_AGAIN_LABEL = 'Upload again';
export const UPLOAD_AGAIN_MSG = 'This song was an upload. Upload the file again to play it.';
export const REMOVE_NOTE = 'Its link, title, BPM and key are deleted. This can’t be undone.';

/** The retention sentence under the page heading. Free's 24 h stays exact (PB-1). */
export const LIBRARY_NOTE_SIGNED_IN =
  'On Free, a song’s audio, stems, loops and chord file are deleted 24 hours after you start it. Its title, BPM and key stay in your library until you remove the song or delete your account, and you can re-make it. On Pro and Studio, songs you start while signed in keep their audio while you are subscribed, and for 30 days after your plan ends.';
export const LIBRARY_NOTE_SIGNED_OUT = 'Files are deleted after 24 hours.';
