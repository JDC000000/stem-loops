// The address last typed on /login, kept briefly so a failed email link can prefill it (QW-6).
//
// When an email link fails in THIS browser (a used sign-up link, a one-time link whose exchange
// failed), the person lands back on /login with the form empty. The address they typed when they
// asked for the link is put back. A link opened in ANOTHER browser cannot be prefilled: nothing
// about the address is ever put in a URL (it would land in request logs and analytics).
//
// Short-lived (REMEMBER_TTL_MS, the same 30 min a pending song link waits) and cleared on sign-in
// and sign-out, so a shared device does not keep showing someone's address.
//
// Pure and import-free (tests load it through a transpile).

export const REMEMBERED_EMAIL_KEY = 'sl.loginEmail';
export const REMEMBER_TTL_MS = 30 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberEmail(store: Store | null | undefined, email: string, now: number = Date.now()): void {
  const e = email.trim();
  if (!store || !e || e.length > 320) return;
  try {
    store.setItem(REMEMBERED_EMAIL_KEY, JSON.stringify({ e, at: now }));
  } catch {
    /* blocked storage: nothing to prefill later */
  }
}

/** The remembered address if it is fresh, else null (a stale or malformed entry is removed). */
export function recallEmail(store: Store | null | undefined, now: number = Date.now()): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(REMEMBERED_EMAIL_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { e?: unknown; at?: unknown };
    if (typeof p?.e === 'string' && p.e && typeof p.at === 'number' && p.at <= now && now - p.at <= REMEMBER_TTL_MS) {
      return p.e;
    }
    store.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    /* fall through */
  }
  return null;
}

export function forgetEmail(store: Store | null | undefined): void {
  try {
    store?.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    /* nothing to clear */
  }
}
