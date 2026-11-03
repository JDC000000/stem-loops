// Supabase server-side auth helper for Next.js App Router.
// Uses @supabase/ssr so the session cookie set by the browser (Supabase Auth
// client) is readable on the server and routes can call `getUser()` to pull
// the authenticated user without us managing JWTs by hand.
//
// The returned supabase client ALSO carries RLS context: queries executed
// through it hit the DB with auth.uid() set, so RLS policies apply. For our
// billing routes we mostly use the server-side pg pool (service_role effect
// in local dev; prod will use Supabase's connection pooler with the secret
// key) and `getUser()` only for identity — not the supabase client for data.

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. In Vercel/local env: add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from your Supabase project settings.`,
    );
  }
  return v;
}

/** Build a per-request Supabase client bound to the current cookie jar. */
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    envOrThrow('NEXT_PUBLIC_SUPABASE_URL'),
    envOrThrow('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          // In a route handler the cookie jar is writable; in a Server
          // Component it isn't. Swallow the error in that case — the
          // middleware/edge should be refreshing session cookies anyway.
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            /* read-only context */
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch {
            /* read-only context */
          }
        },
      },
    },
  );
}

export type AuthUser = {
  id: string;
  email: string;
};

/**
 * Return the signed-in user, or null if the request isn't authenticated.
 * Never throws for an unauthenticated request — callers decide the 401.
 */
export async function getUser(): Promise<AuthUser | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user || !user.email) return null;
    return { id: user.id, email: user.email };
  } catch {
    // Missing env var or Supabase error — treat as unauthenticated.
    return null;
  }
}
