// Sign in BEFORE the job starts (A4, 2026-11-21; Jon's J1 story).
//
// Before this, a signed-out visitor who pasted a link started an ANONYMOUS job, was sent to the
// job page, and only THERE hit the sign-in wall (app/jobs/[id]/page.tsx). The job ran (our
// compute), stayed user_id NULL after sign-in (nothing calls /api/users/me/claim-jobs), and so
// never showed up in the visitor's Song library.
//
// Now the home form (components/landing/ToolForm.tsx), for a LINK and a signed-out visitor:
//   1. validates the link and keeps only its CANONICAL form (lib/youtube-url.ts);
//   2. saves it here, with the time, in localStorage;
//   3. sends the visitor to /login?return_to=/?resume=link (Google first);
//   4. after sign-in, /login sends the browser to PENDING_RETURN_TO; the form sees the marker,
//      TAKES the saved link (read once, deleted at once), re-validates it, and submits it as the
//      signed-in user, so the job is theirs from the start.
//
// SAFETY. Nothing in a URL is ever executed: the marker `resume=link` carries no data, and the
// link itself comes only from this browser's own storage, written by this browser's own submit.
// A crafted /?resume=link without a saved link does nothing; a saved link that is not a canonical
// YouTube URL, or is older than PENDING_TTL_MS, is dropped; the entry is removed on the first
// read, so it can start at most one job.
//
// WHY localStorage, not sessionStorage: a one-time email link and a sign-up confirmation open in
// a NEW tab, which does not share sessionStorage, so the song would be lost on those paths.
// localStorage is same-origin only, and the TTL and the one-shot read bound how long it can wait.
// Google sign-in returns to the same tab, where either store would work.
import { canonicalizeYoutubeUrl } from './youtube-url.ts';

export const PENDING_LINK_KEY = 'sl.pendingLink';
/** Where /login sends the browser after sign-in. The marker only; never the link itself. */
export const PENDING_RETURN_TO = '/?resume=link';
/** The query parameter (and value) the home form looks for. */
export const RESUME_PARAM = 'resume';
export const RESUME_VALUE = 'link';
/** How long a saved link may wait for its sign-in. Long enough for an email confirmation. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** /login, set to come back to the home form and start the saved link. */
export function pendingSignInHref(): string {
  return `/login?return_to=${encodeURIComponent(PENDING_RETURN_TO)}`;
}

/** Save the CANONICAL form of `raw`. Returns false (and saves nothing) for a non-YouTube link. */
export function savePendingLink(store: Store | null | undefined, raw: string, now: number = Date.now()): boolean {
  const url = canonicalizeYoutubeUrl(raw);
  if (!url || !store) return false;
  try {
    store.setItem(PENDING_LINK_KEY, JSON.stringify({ url, at: now }));
    return true;
  } catch {
    return false; // storage full or blocked: the caller falls back to starting signed out
  }
}

/**
 * Take the saved link: always removes the entry, then returns it only if it is a canonical
 * YouTube URL saved within PENDING_TTL_MS (and not in the future). Otherwise null.
 */
export function takePendingLink(store: Store | null | undefined, now: number = Date.now()): string | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PENDING_LINK_KEY);
    store.removeItem(PENDING_LINK_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { url, at } = parsed as { url?: unknown; at?: unknown };
  if (typeof url !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (at > now || now - at > PENDING_TTL_MS) return null;
  // Re-validate: only a link that is ALREADY canonical is accepted, so nothing but a plain
  // https://www.youtube.com/watch?v=<11 chars> can come out of here.
  return canonicalizeYoutubeUrl(url) === url ? url : null;
}

/** True when `search` (a location.search string) carries the resume marker. */
export function hasResumeMarker(search: string): boolean {
  try {
    return new URLSearchParams(search).get(RESUME_PARAM) === RESUME_VALUE;
  } catch {
    return false;
  }
}
