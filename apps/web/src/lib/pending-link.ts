// Sign in BEFORE the job starts (A4, 2026-11-21; Jon's J1 story).
//
// Before this, a signed-out visitor who pasted a link started an ANONYMOUS job, was sent to the
// job page, and only THERE hit the sign-in wall (app/jobs/[id]/page.tsx). The job ran (our
// compute), stayed user_id NULL after sign-in (nothing calls /api/users/me/claim-jobs), and so
// never showed up in the visitor's Song library.
//
// Now the home form (components/landing/ToolForm.tsx), for a LINK and a signed-out visitor:
//   1. validates the link and keeps only its CANONICAL form (lib/youtube-url.ts);
//   2. saves it here with the time and a random NONCE, in localStorage;
//   3. sends the visitor to /login?return_to=/?resume=link&n=<nonce> (Google first);
//   4. after sign-in, /login sends the browser back there; the form CLAIMS the saved link
//      (claimPendingLink: under a Web Lock, read once and deleted at once, the nonce must match,
//      the link is re-validated, and a 60 s in-flight guard per link refuses a second start) and
//      submits it as the signed-in user, so the job is theirs from the start.
//
// SAFETY. Nothing in a URL is ever executed: the marker carries only `resume=link` and an opaque
// nonce, and the link itself comes only from this browser's own storage, written by this
// browser's own submit. A crafted /?resume=link without the matching saved entry does nothing; a
// saved link that is not a canonical YouTube URL, is older than PENDING_TTL_MS, or carries another
// nonce is dropped; the entry is removed on the first read, so it can start at most one job.
//
// BOUND TO ITS FLOW (review of #332, M-11):
//   * the nonce ties the entry to the one /login round trip that created it;
//   * any home load WITHOUT the matching marker takes the entry out (it only puts the link back in
//     the box, never starts it), so a normal visit, a Back from /login, or another person's
//     ordinary sign-in on the same device can never start it later;
//   * sign-out clears it (clearPendingLink, called by every sign-out in the app);
//   * the /login "waiting" line offers "Not your song?", which clears it before signing in.
//
// TWO TABS (review of #332, M-11): the email-confirm link opens a new tab while GoTrue also signs
// the original /login tab in, so two tabs can reach the marker together. The claim runs inside
// navigator.locks.request (one tab at a time, across the origin); where Web Locks are missing it
// falls back to a compare-and-delete with a random claim token. Inside the claim, a per-link
// in-flight guard (IN_FLIGHT_MS) refuses a second start of the same link.
//
// WHY localStorage, not sessionStorage: a one-time email link and a sign-up confirmation open in
// a NEW tab, which does not share sessionStorage, so the song would be lost on those paths.
import { canonicalizeYoutubeUrl } from './youtube-url.ts';

export const PENDING_LINK_KEY = 'sl.pendingLink';
/** Per-link "a start is in flight" marks: `${IN_FLIGHT_PREFIX}<canonical url>` -> epoch ms. */
export const IN_FLIGHT_PREFIX = 'sl.linkStart:';
export const IN_FLIGHT_MS = 60 * 1000;
/** The Web Lock name the claim runs under. */
export const PENDING_LOCK = 'sl.pendingLink';
/** The query parameters the home form looks for. */
export const RESUME_PARAM = 'resume';
export const RESUME_VALUE = 'link';
export const NONCE_PARAM = 'n';
/** How long a saved link may wait for its sign-in. Long enough for an email confirmation. */
export const PENDING_TTL_MS = 30 * 60 * 1000;
const NONCE_RE = /^[0-9a-f]{32}$/;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LockManagerLike = { request: (name: string, cb: () => Promise<unknown>) => Promise<unknown> };

/** 128 random bits as 32 hex characters. Opaque: it carries no data. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The home URL /login returns to: the marker and the nonce only, never the link. */
export function pendingReturnTo(nonce: string): string {
  return `/?${RESUME_PARAM}=${RESUME_VALUE}&${NONCE_PARAM}=${nonce}`;
}

/** /login, set to come back to the home form and start the saved link. */
export function pendingSignInHref(nonce: string): string {
  return `/login?return_to=${encodeURIComponent(pendingReturnTo(nonce))}`;
}

/** The nonce of a resume marker in `search` (a location.search string), or null. */
export function resumeNonce(search: string): string | null {
  try {
    const q = new URLSearchParams(search);
    if (q.get(RESUME_PARAM) !== RESUME_VALUE) return null;
    const n = q.get(NONCE_PARAM) ?? '';
    return NONCE_RE.test(n) ? n : null;
  } catch {
    return null;
  }
}

/** True when `dest` (a sanitised return_to) is a pending-link return: `/?resume=link&n=<nonce>`. */
export function isPendingReturnTo(dest: string): boolean {
  return dest.startsWith('/?') && resumeNonce(dest.slice(1)) !== null;
}

/** True when `search` carries the resume marker at all (with or without a valid nonce). */
export function hasResumeMarker(search: string): boolean {
  try {
    return new URLSearchParams(search).get(RESUME_PARAM) === RESUME_VALUE;
  } catch {
    return false;
  }
}

/**
 * Save the CANONICAL form of `raw` with `nonce`. Returns false (and saves nothing) for a
 * non-YouTube link, a malformed nonce, or a storage that refuses the write.
 */
export function savePendingLink(store: Store | null | undefined, raw: string, nonce: string, now: number = Date.now()): boolean {
  const url = canonicalizeYoutubeUrl(raw);
  if (!url || !store || !NONCE_RE.test(nonce)) return false;
  try {
    store.setItem(PENDING_LINK_KEY, JSON.stringify({ url, at: now, nonce }));
    return store.getItem(PENDING_LINK_KEY) !== null; // a storage that swallows writes counts as blocked
  } catch {
    return false;
  }
}

/** Remove the saved link (sign-out, "Not your song?", a home load without the marker). */
export function clearPendingLink(store: Store | null | undefined): void {
  try {
    store?.removeItem(PENDING_LINK_KEY);
  } catch {
    /* blocked storage holds nothing to clear */
  }
}

type Parsed = { url: string; at: number; nonce: string };

function parseEntry(raw: string | null, now: number): Parsed | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { url, at, nonce } = parsed as { url?: unknown; at?: unknown; nonce?: unknown };
  if (typeof url !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || typeof nonce !== 'string') return null;
  if (at > now || now - at > PENDING_TTL_MS) return null;
  // Re-validate: only a link that is ALREADY canonical is accepted, so nothing but a plain
  // https://www.youtube.com/watch?v=<11 chars> can come out of here.
  if (canonicalizeYoutubeUrl(url) !== url) return null;
  return { url, at, nonce };
}

/**
 * Take the saved link: ALWAYS removes the entry, then returns it only if it is a canonical
 * YouTube URL saved within PENDING_TTL_MS and, when `nonce` is a string, saved with that nonce.
 * `nonce === null` takes it for a PREFILL only (never a start): any fresh, valid entry.
 */
export function takePendingLink(store: Store | null | undefined, nonce: string | null, now: number = Date.now()): string | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PENDING_LINK_KEY);
    store.removeItem(PENDING_LINK_KEY);
  } catch {
    return null;
  }
  const e = parseEntry(raw, now);
  if (!e) return null;
  if (nonce !== null && e.nonce !== nonce) return null;
  return e.url;
}

/** Mark `url` as starting now unless a start began within IN_FLIGHT_MS. True = this caller may start it. */
export function markInFlight(store: Store, url: string, now: number = Date.now()): boolean {
  const key = IN_FLIGHT_PREFIX + url;
  try {
    const prev = Number(store.getItem(key));
    if (Number.isFinite(prev) && prev > 0 && now - prev >= 0 && now - prev < IN_FLIGHT_MS) return false;
    store.setItem(key, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Drop the in-flight mark (the start failed, so a retry must be allowed). */
export function clearInFlight(store: Store | null | undefined, url: string): void {
  try {
    store?.removeItem(IN_FLIGHT_PREFIX + url);
  } catch {
    /* nothing to clear */
  }
}

const CLAIM_KEY = `${PENDING_LINK_KEY}.claim`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The ONE way a resume starts a job: atomically take the saved link for `nonce` and mark it in
 * flight. Returns the canonical link to start, or null (nothing saved, wrong nonce, stale,
 * tampered, or another tab got there first).
 */
export async function claimPendingLink(opts: {
  store: Store | null | undefined;
  nonce: string;
  locks?: LockManagerLike | null;
  now?: () => number;
  claimToken?: string;
}): Promise<string | null> {
  const { store, nonce } = opts;
  const now = opts.now ?? Date.now;
  if (!store || !NONCE_RE.test(nonce)) return null;
  const critical = (): string | null => {
    const url = takePendingLink(store, nonce, now());
    if (!url) return null;
    return markInFlight(store, url, now()) ? url : null;
  };
  if (opts.locks && typeof opts.locks.request === 'function') {
    let got: string | null = null;
    await opts.locks.request(PENDING_LOCK, async () => {
      got = critical();
    });
    return got;
  }
  // No Web Locks: compare-and-delete with a random claim token. Each tab writes its token, waits
  // for the other tab's write to land, and only the tab whose token is still there proceeds.
  const token = opts.claimToken ?? newNonce();
  try {
    const held = store.getItem(CLAIM_KEY);
    if (held) {
      const at = Number(held.split('@')[1]);
      if (Number.isFinite(at) && now() - at < 5000) return null; // another tab is claiming
    }
    store.setItem(CLAIM_KEY, `${token}@${now()}`);
  } catch {
    return null;
  }
  await sleep(60);
  try {
    if ((store.getItem(CLAIM_KEY) ?? '').split('@')[0] !== token) return null;
    return critical();
  } finally {
    try {
      if ((store.getItem(CLAIM_KEY) ?? '').split('@')[0] === token) store.removeItem(CLAIM_KEY);
    } catch {
      /* ignore */
    }
  }
}
