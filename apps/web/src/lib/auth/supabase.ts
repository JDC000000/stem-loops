// Supabase Auth plumbing — V3 Phase 1a (TSD §2.1 / V3-U1).
//
// SINGLE boundary between our app and @supabase/ssr. Pages, route handlers
// and components call the functions here — they never import from
// `@supabase/ssr` or `@supabase/supabase-js` directly. If the IdP ever
// changes (or we add magic-link SSO, etc.) the swap happens inside this
// file and the AuthenticatedUser shape above stays stable.
//
// Three sign-in methods are supported by Supabase Auth per TSD §2.1:
//   • email + password
//   • magic link (passwordless OTP via email)
//   • Google OAuth
// This file doesn't implement sign-in UI — it exposes the clients that UI
// pages use to call `supabase.auth.signInWith...`, plus a server-side
// `getUser()` that is the authoritative trust boundary.
//
// Security — getUser() vs getSession():
//   `supabase.auth.getSession()` reads the session from the cookie and
//   DOES NOT revalidate it against the Supabase server. An attacker who
//   forges the cookie (shouldn't be possible, but defense-in-depth) would
//   pass that check. `supabase.auth.getUser()` round-trips to Supabase
//   and verifies the access token. Server-side auth decisions — RLS
//   policies that rely on `auth.uid()`, admission to protected routes,
//   entitlement checks for billing — MUST go through `getUser()`.
//
//   Supabase's own SSR docs call this out explicitly:
//     "Always use supabase.auth.getUser() to protect pages and user data.
//      Never trust supabase.auth.getSession() inside server code."

import { createBrowserClient as createSupabaseBrowserClient, createServerClient as createSupabaseServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedUser } from './types';

// Re-export so downstream agents only import from '@/lib/auth/supabase'.
export type { AuthenticatedUser } from './types';

/**
 * Reads the Supabase public URL and anon/publishable key from the
 * environment and throws a loud error if either is missing. Calling it on
 * every client build (instead of caching module-level constants) means a
 * mis-set preview env surfaces as a 500 at request time with a clear
 * message, not a cryptic `Invalid URL` deep in supabase-js.
 *
 * These are PUBLIC values and intentionally shipped to the browser — the
 * anon key is scoped by RLS and is safe to expose. Do not substitute the
 * `service_role` key here; that one must never leave the server.
 */
function readPublicEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. Add it to Vercel project env ' +
        '(and .env.local for dev).',
    );
  }
  if (!anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Add it to Vercel project ' +
        'env (and .env.local for dev). This is a PUBLIC key — do NOT use ' +
        'the service_role key.',
    );
  }
  return { url, anonKey };
}

/**
 * Browser Supabase client — for use inside `'use client'` components that
 * initiate sign-in flows (`supabase.auth.signInWithPassword`,
 * `signInWithOtp`, `signInWithOAuth`) and listen to auth state changes.
 *
 * `@supabase/ssr`'s `createBrowserClient` wires the session into cookies
 * (not localStorage), so the server can see the same session the browser
 * writes — that's the whole point of the SSR package.
 *
 * Returns a fresh client — the underlying library handles its own
 * singleton-per-page semantics via the cookie store, so there's no need
 * to cache a module-level instance here.
 */
export function createBrowserClient(): SupabaseClient {
  const { url, anonKey } = readPublicEnv();
  return createSupabaseBrowserClient(url, anonKey);
}

/**
 * Server Supabase client — for use inside Server Components, Route
 * Handlers, and Server Actions.
 *
 * The cookie adapter is lazy-loaded so this module stays importable from
 * code paths that never hit the request cycle (e.g. a type-only import).
 * We pull `cookies()` from `next/headers` inside the factory; calling it
 * outside a request scope will throw with Next's standard error, which
 * is the right failure mode.
 *
 * `setAll` is best-effort: Server Components themselves can't write
 * cookies in Next 14, and will throw if `setAll` tries to. We swallow
 * that error — the middleware is the real refresh path (see
 * `src/middleware.ts`). Route handlers CAN set cookies, so `setAll`
 * works there as expected. This is the pattern the Supabase SSR docs
 * prescribe for Next.js 14.
 */
export async function createServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = readPublicEnv();
  // Dynamic import keeps this module compatible with non-Next environments
  // (e.g. the test file under `apps/web/test/`, which mocks it out).
  const { cookies } = await import('next/headers');
  const cookieStore = cookies();

  return createSupabaseServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't set cookies; middleware handles it.
          // Any other caller (route handler, action) WILL see the write.
        }
      },
    },
  });
}

/**
 * Resolves the authenticated user for the current server-side request,
 * or `null` when no verified session is present.
 *
 * This is the function callers reach for 99% of the time. It:
 *   1. Builds a server client bound to this request's cookies.
 *   2. Calls `supabase.auth.getUser()` — round-trip to Supabase that
 *      VERIFIES the access token. Do NOT replace with `getSession()`.
 *   3. Maps the verified Supabase `User` onto our opaque
 *      `AuthenticatedUser` shape, so callers never see Supabase types.
 *
 * `display_name` comes from `user_metadata.name` or `.full_name` when
 * present (Google OAuth populates both), otherwise it stays undefined.
 * Some sign-ups (email+password with no profile page yet) legitimately
 * have no name — callers must handle `undefined`, not assume a string.
 *
 * Returns `null` on any auth error (no cookie, expired session not
 * refreshable, user deleted from Supabase, token signature invalid).
 * Callers that need to distinguish "logged out" from "server down"
 * should build a different helper — for the common path "who is this
 * request?" the answer is simply absent.
 */
export async function getUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  const { id, email, user_metadata } = data.user;
  // email is nullable in supabase-js's type (phone-only signup), but every
  // sign-in method in our TSD is email-based — treat a missing email as
  // "no verified identity" and refuse.
  if (!email) return null;
  const raw = (user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const fullName = typeof raw.full_name === 'string' ? raw.full_name : undefined;
  const display_name = name ?? fullName;
  return display_name ? { user_id: id, email, display_name } : { user_id: id, email };
}
