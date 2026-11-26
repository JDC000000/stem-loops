// Limits for POST /api/auth/resend-confirmation (QW-7).
//
// Two fixed windows, in process, checked AFTER the same-origin guard and BEFORE hCaptcha is
// verified or Supabase is called:
//
//   • per client IP: RESEND_IP_LIMIT requests per RESEND_IP_WINDOW_MS. Over it the route answers
//     429. That says nothing about any address, so it is not an enumeration oracle.
//   • per address (lower-cased): one send per RESEND_EMAIL_WINDOW_MS. Over it the route answers
//     the SAME 200 as a send and sends nothing, so a second try never tells anyone whether the
//     address has an account.
//
// Per INSTANCE, like lib/read-rate-limit.ts: several Vercel instances can each admit the limit.
// hCaptcha on every request is the real cost for a script; Supabase's own email rate limit
// (resend: one per address per 60 s, plus the project-wide email cap) is the global backstop.
// A platform rule (Vercel WAF) is the global fix and is listed as residue in the PR.
//
// Pure and import-free so the route test can load it through a data-URL transpile.

export const RESEND_IP_WINDOW_MS = 10 * 60_000;
export const RESEND_IP_LIMIT = 5;
export const RESEND_EMAIL_WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

type Window = { start: number; count: number };
const ipWindows = new Map<string, Window>();
const emailSent = new Map<string, number>();

function bound<V>(m: Map<string, V>): void {
  while (m.size >= MAX_KEYS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/** True when this IP may make another request now (and counts it); false when over the limit. */
export function admitResendIp(ip: string, now: number = Date.now()): boolean {
  let w = ipWindows.get(ip);
  if (!w || now - w.start >= RESEND_IP_WINDOW_MS) {
    if (!w) bound(ipWindows);
    w = { start: now, count: 0 };
    ipWindows.delete(ip);
    ipWindows.set(ip, w);
  }
  if (w.count >= RESEND_IP_LIMIT) return false;
  w.count += 1;
  return true;
}

/** Seconds until this IP's window resets (for Retry-After). */
export function resendIpRetryAfterSec(ip: string, now: number = Date.now()): number {
  const w = ipWindows.get(ip);
  if (!w) return 1;
  return Math.max(1, Math.ceil((w.start + RESEND_IP_WINDOW_MS - now) / 1000));
}

/** True when a mail may go to this address now (and records it); false inside its window. */
export function admitResendEmail(email: string, now: number = Date.now()): boolean {
  const key = email.trim().toLowerCase();
  const last = emailSent.get(key);
  if (last !== undefined && now - last < RESEND_EMAIL_WINDOW_MS && now >= last) return false;
  if (last === undefined) bound(emailSent);
  emailSent.delete(key);
  emailSent.set(key, now);
  return true;
}

/** Test hook: forget every window. */
export function _resetResendLimits(): void {
  ipWindows.clear();
  emailSent.clear();
}
