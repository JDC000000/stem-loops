// Who may do WHAT to a job. The ONE place the rule lives (design v1.5, P3.1 route-rule
// table), so the routes cannot drift apart. Every job-scoped route asks this module.
//
// THE RULE FOR AN ORDINARY JOB (is_demo false) — unchanged from SEC-1:
//   * a job whose `user_id` IS NULL is an anonymous job. It was started without an
//     account, so there is no owner to check against; the unguessable job UUID is its
//     only credential, exactly as the privacy page's "Links to jobs" section says.
//   * a job whose `user_id` is set may be read ONLY by that user. Anyone else —
//     signed out, or signed in as somebody else — is told the job does not exist
//     (404, never 403: a 403 would confirm that the id is real).
//
// THE RULE FOR A DEMO SONG (is_demo true; migration 040; DB-12a, Jon 2026-11-17:
// "should people play the demo songs without signing in? I recommend yes, for the demos
// only."). Demo songs are owned by the dedicated demo system account.
//   * READ (the job, its stems for playback, its chords and sections): everyone, signed
//     out included. These are the only actions the is_demo branch OPENS.
//   * Everything else — WAV/stem download, loop cutting, chord edits, delete, claim —
//     is the owner (the demo system account, "the operator") ONLY. An explicit is_demo
//     branch, not the anonymous-job rule: if the demo account is ever deleted, `user_id`
//     becomes NULL (ON DELETE SET NULL), and a NULL-owner demo must NOT turn into an
//     anonymous job that anyone may download or cut. It is then nobody's: denied to all.
//
// FAIL CLOSED, in both directions:
//   * Only a literal `null` owner means "anonymous". `undefined` — a SELECT that forgot to
//     read `user_id` — is treated as OWNED, so it denies everyone.
//   * Only a literal `true` means "demo". `undefined`/null — a SELECT that forgot to read
//     `is_demo` — is treated as NOT a demo, which for a demo row (owned by the system
//     account) means "someone else's job": 404. A missed column can only close a demo,
//     never open an ordinary job.
//   * `getUser()` throwing propagates to the route's 500 handler, which also denies.
//
// A page redirect is not an authorisation boundary; this check, on the route that
// actually returns the data, is.
import { getUser } from '@/lib/auth/supabase';

/** Every action a job-scoped route performs. The route-rule table is over these. */
export type JobAction = 'read' | 'download' | 'cut_loops' | 'edit_chords' | 'delete' | 'claim';

export const JOB_ACTIONS: readonly JobAction[] = ['read', 'download', 'cut_loops', 'edit_chords', 'delete', 'claim'];

/** The two columns the rule needs. Pass them straight from the row. */
export interface JobAccessFacts {
  /** jobs.user_id: a uuid, a literal null (anonymous), or undefined (not read -> owned). */
  readonly ownerId: string | null | undefined;
  /** jobs.is_demo: only a literal true is a demo. */
  readonly isDemo?: boolean | null;
}

/**
 * The route-rule table as a pure function: may the caller (`callerId`, null when signed
 * out) perform `action` on this job? No I/O, so every cell is testable directly.
 *
 * Non-demo rows: exactly the rules the routes enforced before Slice 2a —
 *   read / download / cut_loops: owner, or anyone when the job is anonymous (download's
 *     own "sign in first" 401 is the route's, before it gets here);
 *   edit_chords / delete / claim: never by anyone but the owner here — chord edits
 *     require `user_id = caller` (chord-edits/route.ts), and claim is its own route's
 *     query (`user_id IS NULL`), which this module does not replace for ordinary jobs.
 */
export function decideJobAccess(action: JobAction, facts: JobAccessFacts, callerId: string | null): boolean {
  const { ownerId } = facts;
  const isOwner = typeof ownerId === 'string' && callerId !== null && callerId === ownerId;
  if (facts.isDemo === true) {
    // The is_demo branch: reads open to everyone; every other action owner-only, and a
    // demo with no owner (NULL after an account deletion) is nobody's.
    return action === 'read' ? true : isOwner;
  }
  switch (action) {
    case 'read':
    case 'download':
    case 'cut_loops':
      return ownerId === null || isOwner;
    case 'edit_chords':
    case 'delete':
      return isOwner;
    case 'claim':
      // Claiming means taking an UNOWNED job; an owned job is never claimable.
      return ownerId === null && callerId !== null;
  }
}

/**
 * May the current caller READ this job (GET /api/jobs/:id, /stems, /play-chords, and the
 * player page)? `isDemo` is optional so a caller that has not been taught about demos
 * keeps the pre-2a behaviour exactly (a demo then stays a 404 to non-owners).
 *
 * The session is looked up only when the answer depends on it: an anonymous job and a
 * demo song are readable whoever asks.
 */
export async function mayReadJob(ownerId: string | null | undefined, isDemo?: boolean | null): Promise<boolean> {
  if (isDemo === true || ownerId === null) return decideJobAccess('read', { ownerId, isDemo }, null);
  const user = await getUser();
  return decideJobAccess('read', { ownerId, isDemo }, user?.user_id ?? null);
}

/** Any action other than a read. Always resolves the caller (these are never public). */
export async function mayActOnJob(action: Exclude<JobAction, 'read'>, facts: JobAccessFacts): Promise<boolean> {
  const user = await getUser();
  return decideJobAccess(action, facts, user?.user_id ?? null);
}
