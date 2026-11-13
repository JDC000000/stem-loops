// Same-origin (CSRF) guard for state-changing API routes.
//
// Extracted from the check DELETE /api/users/me has carried since Phase 1b, so
// every route that changes state on the caller's behalf uses ONE rule:
//
//   • Origin header REQUIRED. Missing Origin → refused (fails closed). Every
//     current browser sends Origin on a POST/DELETE fetch, same-origin
//     included, so the only callers without one are non-browser clients, which
//     these routes do not serve. This is the users/me behaviour, kept as is.
//   • Literal `Origin: null` (sandboxed iframe, data: URL, some redirects) → refused.
//   • Host header required, and Origin's host must equal it, after dropping a
//     default port (:443 / :80) on both sides so a proxy that forwards
//     `Host: x.com:443` does not 403 real users.
//
// Why it is needed: the session cookie is SameSite=Lax (the @supabase/ssr
// default), which does NOT stop a cross-site top-level form POST, and a
// `text/plain` POST is a CORS "simple request" that never preflights.
// W1/W2 overnight QA (2026-11-12) got 201 from POST /api/jobs with
// `Origin: https://evil.example` and `Content-Type: text/plain`.
//
// Deliberately NOT applied to /api/billing/webhook: Stripe is a server-to-
// server caller with no Origin, and the webhook authenticates by signature.
//
// Pure and import-free: the route tests load it as-is (data-URL transpile),
// and each route wraps the refusal in its own error-body shape.

type HeaderBag = { get?: (name: string) => string | null | undefined } | null | undefined;
type RequestLike = { headers?: HeaderBag } | null | undefined;

export const BAD_ORIGIN = 'BAD_ORIGIN' as const;

/** Drop a default port so `x.com:443` and `x.com` compare equal. */
const normalizeHost = (h: string) => h.toLowerCase().replace(/:(443|80)$/, '');

/**
 * `null` when the request is same-origin; otherwise the user-facing reason
 * (route answers 403 with code BAD_ORIGIN). Messages match DELETE /api/users/me.
 */
export function crossOriginRefusal(req: RequestLike): string | null {
  const origin = req?.headers?.get?.('origin') ?? null;
  const host = req?.headers?.get?.('host') ?? null;
  if (!origin || origin === 'null' || !host) {
    return 'Cross-origin or non-browser request refused.';
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return 'Malformed Origin header.';
  }
  if (normalizeHost(originHost) !== normalizeHost(host)) {
    return 'Cross-origin request refused.';
  }
  return null;
}
