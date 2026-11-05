// Next.js middleware — refreshes the Supabase session cookie on every
// request that passes through the matcher (see `config.matcher` below), AND
// stamps a CSP + the baseline security headers onto every response.
//
// Why this exists (session refresh, per @supabase/ssr docs):
//   • `supabase-js` auth tokens are short-lived (~1h). A refresh needs
//     write access to the cookies — Server Components can't write
//     cookies in Next 14, only middleware and route handlers can.
//   • Without this middleware, a user's session silently expires an hour
//     after login even if they're actively browsing, because nothing is
//     writing the refreshed access token back.
//   • Middleware also prevents the single-use-refresh-token double-fetch
//     race on page loads: it refreshes once before any Server Component
//     reads the cookie, so concurrent reads inside the same render all
//     see a valid token.
//
// Why this exists (security headers, audit §3 M4):
//   The app had no CSP, no X-Frame-Options, no X-Content-Type-Options, no
//   Referrer-Policy and no Permissions-Policy. The attached host names in
//   `connect-src` are wall-garden-tight — Supabase + R2 + Sentry + the
//   browser's chord-model host — so a compromised dependency can't
//   exfiltrate to an arbitrary attacker-controlled endpoint. `wasm-unsafe-eval`
//   is required for ONNX Runtime Web (chord overlay); `'unsafe-inline'` on
//   `script-src` is a known gap tracked as a follow-up — moving to a per-
//   request nonce + hashed-script path lands in a later PR so this one stays
//   small.
//
// This file does NOT enforce auth — no redirects, no 401s. That's each
// route's own job (via `getUser()` in `lib/auth/supabase`). Middleware
// only keeps the cookie fresh and stamps the security headers. Enforcement
// at this layer would make the auth story hard to reason about and would
// conflict with the public landing/upload flows that don't require login.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// ──────────────────────── security headers ────────────────────────

/**
 * Hosts allowed on the `connect-src` directive. Supabase + R2 (presigned
 * reads) + Sentry (error telemetry) are always permitted; the browser-side
 * chord model URL and the R2 public host are read from env at request time
 * so staging and production can point at different buckets without a
 * middleware patch.
 *
 * Export is for the unit test in `apps/web/test/csp-headers.test.mjs`; no
 * runtime consumer imports this.
 */
export function cspConnectSrcHosts(): string[] {
  const hosts = new Set<string>([
    "'self'",
    'https://*.supabase.co',
    'https://*.r2.cloudflarestorage.com',
    'https://sentry.io',
    'https://o0.ingest.us.sentry.io',
  ]);
  const chordnet = process.env.NEXT_PUBLIC_CHORDNET_MODEL_URL;
  if (chordnet) {
    try {
      const u = new URL(chordnet);
      // Build an origin-only token; CSP sources don't accept paths.
      hosts.add(`${u.protocol}//${u.host}`);
    } catch {
      // Malformed URL in env — skip rather than fail closed; the chord
      // overlay will error on its own when it tries to load the model.
    }
  }
  const r2Public = process.env.R2_PUBLIC_HOST;
  if (r2Public) hosts.add(`https://${r2Public}`);
  return Array.from(hosts);
}

/**
 * Hosts allowed on the `media-src` directive. R2 private bucket gets the
 * presigned-URL wildcard; the public bucket host (if any) is appended so
 * the landing demo clips play without CSP violations.
 */
function mediaSrcHosts(): string[] {
  const hosts = ["'self'", 'https://*.r2.cloudflarestorage.com'];
  const r2Public = process.env.R2_PUBLIC_HOST;
  if (r2Public) hosts.push(`https://${r2Public}`);
  return hosts;
}

/** Build the full Content-Security-Policy value. Pure for unit testing. */
export function buildCsp(): string {
  const connect = cspConnectSrcHosts().join(' ');
  const media = mediaSrcHosts().join(' ');
  return [
    "default-src 'self'",
    // `wasm-unsafe-eval` is required for ORT Web (chord overlay); inline
    // scripts are a known gap tracked as a follow-up nonce migration.
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src ${connect}`,
    'worker-src blob:',
    `media-src ${media}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Baseline security headers that don't need per-request assembly. */
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

/**
 * Stamp CSP + the baseline security headers on a Response. Overwrites any
 * header the downstream handler set — the middleware is the single source
 * of truth for these so a route can't accidentally relax the policy.
 */
function applySecurityHeaders(response: NextResponse): void {
  response.headers.set('Content-Security-Policy', buildCsp());
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) {
    response.headers.set(k, v);
  }
}

// ──────────────────────── session refresh ────────────────────────

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If envs are missing (preview branch misconfig), do nothing — don't
  // break every page in the app. The route-level `getUser()` call will
  // return null and callers will handle it. This is intentional: a
  // middleware that throws takes down the whole site. Security headers
  // still get stamped so the fallback response is not header-naked.
  if (!url || !anonKey) {
    const bare = NextResponse.next({ request });
    applySecurityHeaders(bare);
    return bare;
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write to the incoming request (so downstream handlers see the
        // refreshed cookies) AND to the outgoing response (so the
        // browser stores them). Per Supabase SSR docs: miss either side
        // and you get flaky "random logout" bugs.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touch `getUser()` to trigger a refresh if the access token is
  // expiring. Return value is intentionally unused here — we're not
  // gating anything, just driving the refresh side-effect.
  //
  // IMPORTANT: Use `getUser()` (verifies with Supabase) not
  // `getSession()` (trusts the cookie). The verification cost is the
  // price of the middleware being the trust boundary; everything
  // downstream can then rely on the cookie.
  //
  // Swallow errors: a transient Supabase outage must NOT take down every
  // page in the app (round-1 Lens finding). The route-level `getUser()`
  // will reach Supabase again with its own error path; here we just want
  // the refresh side-effect when it works.
  try {
    await supabase.auth.getUser();
  } catch {
    // intentional: middleware is best-effort, enforcement lives in routes.
  }

  applySecurityHeaders(response);
  return response;
}

// Run on every request except static assets, the Next.js image pipeline,
// and bare crawler paths (robots.txt, sitemap.xml). Keep the matcher
// generous: cheaper to refresh too often than to miss a page that needed
// a fresh session.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
