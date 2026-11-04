// Public interface types for the auth layer — V3 Phase 1a (TSD §2.1 / V3-U1).
//
// These are the ONLY shapes components, pages, and route handlers should see.
// Supabase-specific types (`User`, `Session`, `SupabaseClient`, JWT internals,
// app_metadata, etc.) must never leak past `lib/auth/supabase.ts` — swap-out
// cost later (e.g. to a different IdP) has to stay small, and components get
// an opaque identity, not a Supabase object with 40 fields they never touch.

/**
 * The authenticated user identity, as every caller in the web app sees it.
 *
 * - `user_id` is an opaque UUID string. Treat it as a bag of bytes with no
 *   meaning beyond equality — never parse it, slice it, or expose it in a URL
 *   that should be unguessable.
 * - `email` is the verified email on file for the user. Present for every
 *   sign-in method we support (email+password, magic link, Google OAuth),
 *   because every method lands on an email-identified user.
 * - `display_name` is optional. Populated from the OAuth provider's profile
 *   (Google `name`), or left undefined for email/magic-link signups until
 *   the account page sets it.
 */
export type AuthenticatedUser = {
  user_id: string;
  email: string;
  display_name?: string;
};
