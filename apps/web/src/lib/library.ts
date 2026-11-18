// The /history page's list: the signed-in user's LIBRARY (GET /api/library, from the
// database, owner-scoped on the server) merged with this browser's anonymous history
// (lib/history.ts, localStorage).
//
// Jon, 2026-11-15: Free = 24 hours. Pro and Studio = kept while subscribed, plus 30 days'
// grace after the subscription ends. Users build a LIBRARY of songs.
//
// Pure and free of `@/` imports so src/lib/library.test.mjs can load it directly.
import { jobLabel, shortSource } from './job-label.ts';
import { RETENTION_MS } from './retention.ts';
import { songThumbnailUrl } from './song-thumb.ts';

/** One row of GET /api/library. `expires_at` is the song's real deletion time. */
export type LibraryRow = {
  id: string;
  title?: string | null;
  original_filename?: string | null;
  youtube_url?: string | null;
  /** Usually empty on recent rows (P5.1); the thumbnail falls back to youtube_url. */
  video_id?: string | null;
  status?: string;
  created_at: string;
  expires_at: string;
  /** Demo song (migration 040): its expires_at is 2099-12-31; no "deleted in" is shown. */
  is_demo?: boolean;
};

/** A browser-history entry (lib/history.ts HistoryEntry). */
export type BrowserEntry = { id: string; at: number };

export type ListedSong = {
  id: string;
  label: string;
  createdAtMs: number;
  /** When it is deleted. Library: the server's deadline. Browser-only: at + 24 h. */
  expiresAtMs: number;
  source: 'library' | 'browser';
  /** A demo song: the list shows no "deleted in" for it. Library rows only. */
  isDemo: boolean;
  /** i.ytimg.com thumbnail for a linked song (P5.1), else null. Library rows only. */
  thumbUrl: string | null;
  /**
   * What the row can do (QA A-06): 'ready' plays, 'processing' is on its way,
   * 'failed' never plays (the list shows a status chip and no thumbnail).
   * 'unknown' for a browser-only entry, whose status this page never fetched.
   */
  state: SongState;
};

export type SongState = 'ready' | 'processing' | 'failed' | 'unknown';

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
  return null;
}

const ms = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/**
 * Library songs (server deadline, human label) first-class; browser-only entries kept
 * with Free's 24 h clock (they are anonymous jobs, or not this account's). A browser
 * entry for an id the library also has is dropped: the library row is the truth.
 * Expired entries are left out. Newest first.
 */
export function listedSongs(
  library: readonly LibraryRow[] | null,
  browser: readonly BrowserEntry[],
  nowMs: number = Date.now(),
): ListedSong[] {
  const out = new Map<string, ListedSong>();
  for (const r of library ?? []) {
    const createdAtMs = ms(r.created_at);
    const expiresAtMs = ms(r.expires_at);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    const state = songState(r.status);
    // A link with no title yet is listed by its short host/ID form, not the raw URL (QA A-06).
    const label = r.title?.trim() || r.original_filename?.trim() ? jobLabel(r) : r.youtube_url?.trim() ? shortSource(r.youtube_url) : jobLabel(r);
    out.set(r.id, {
      id: r.id, label, createdAtMs, expiresAtMs, source: 'library', isDemo: r.is_demo === true,
      // A failed song shows no video still: nothing about the row may look playable.
      thumbUrl: state === 'failed' ? null : songThumbnailUrl(r),
      state,
    });
  }
  for (const e of browser) {
    if (out.has(e.id)) continue;
    const expiresAtMs = e.at + RETENTION_MS;
    if (expiresAtMs <= nowMs) continue;
    out.set(e.id, { id: e.id, label: e.id, createdAtMs: e.at, expiresAtMs, source: 'browser', isDemo: false, thumbUrl: null, state: 'unknown' });
  }
  return Array.from(out.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** The retention sentence under the page heading. Free's 24 h stays exact. */
export const LIBRARY_NOTE_SIGNED_IN =
  'On Free, songs are deleted 24 hours after you start them. On Pro and Studio, songs you start while signed in stay in your library while you are subscribed, and for 30 days after your plan ends.';
export const LIBRARY_NOTE_SIGNED_OUT = 'Files are deleted after 24 hours.';
