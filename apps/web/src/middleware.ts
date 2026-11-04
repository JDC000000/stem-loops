// Next.js middleware — refreshes the Supabase session cookie on every
// request that passes through the matcher (see `config.matcher` below).
//
// Why this exists (per @supabase/ssr docs):
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
// This file does NOT enforce auth — no redirects, no 401s. That's each
// route's own job (via `getUser()` in `lib/auth/supabase`). Middleware
// only keeps the cookie fresh. Enforcement at this layer would make the
// auth story hard to reason about and would conflict with the public
// landing/upload flows that don't require login.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If envs are missing (preview branch misconfig), do nothing — don't
  // break every page in the app. The route-level `getUser()` call will
  // return null and callers will handle it. This is intentional: a
  // middleware that throws takes down the whole site.
  if (!url || !anonKey) {
    return NextResponse.next({ request });
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
