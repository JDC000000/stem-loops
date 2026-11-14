// Who may READ a job's data through the job-scoped GET routes.
//
// THE RULE (one place, so the three routes cannot drift apart):
//   * a job whose `user_id` IS NULL is an anonymous job. It was started without an
//     account, so there is no owner to check against; the unguessable job UUID is its
//     only credential, exactly as the privacy page's "Links to jobs" section says.
//   * a job whose `user_id` is set may be read ONLY by that user. Anyone else —
//     signed out, or signed in as somebody else — is told the job does not exist
//     (404, never 403: a 403 would confirm that the id is real).
//
// This is the same rule POST/GET /api/jobs/:id/loops already enforces
// (api/jobs/[id]/loops/route.ts `authorize`). It is deliberately NOT "deny when
// user_id is null" (that would break the anonymous start flow, which has an
// anonymous INSERT branch in POST /api/jobs) and NOT "allow when user_id is null AND
// when it is set" (that is the hole: /api/jobs/:id, /stems and /play-chords used to do
// that, handing presigned R2 URLs for a signed-in user's stems to anyone with the id).
//
// FAIL CLOSED. Only a literal `null` means "anonymous". `undefined` — a SELECT that
// forgot to read the column — is treated as OWNED, so a query that drops `user_id`
// denies everyone instead of silently opening every job. `getUser()` throwing
// propagates to the route's 500 handler, which also denies.
//
// A page redirect is not an authorisation boundary; this check, on the API route that
// actually returns the data, is.
import { getUser } from '@/lib/auth/supabase';

export async function mayReadJob(ownerId: string | null): Promise<boolean> {
  if (ownerId === null) return true;
  const user = await getUser();
  return user !== null && typeof ownerId === 'string' && user.user_id === ownerId;
}
