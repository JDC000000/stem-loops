// The server half of the signed-in header: it reads the session, the nav
// renders it.
//
// MOUNTED BY: app/{account,jobs,history,login,pricing,success,trial}/layout.tsx
// — seven one-line layouts, one per signed-in subtree. See the comment in
// app/account/layout.tsx for why a layout per subtree rather than one route
// group, and test/signed-in-nav.test.mjs for the gate that fails when a
// routable page appears outside that set.
//
// THIS COMPONENT READS THE SESSION AND NOTHING ELSE, AND THAT IS DELIBERATE.
// An earlier revision resolved the viewer's newest job from the `sl-history`
// cookie so "Play along" could deep-link to it. Three faults, each on an
// ordinary path, not an exotic one:
//
//   1. `sl-history` is the ANONYMOUS history mirror. It is per-BROWSER and is
//      never scoped to the signed-in user, while this bar is per-SESSION. On a
//      shared machine — A runs a track, signs out, B signs in — B's nav would
//      point at A's job, and app/jobs/[id]/page.tsx checks `getUser()` but does
//      NO ownership check. That turns a pre-existing weakness into one click.
//   2. The ids carry no timestamps (lib/history.ts) and are never pruned, while
//      the cookie's maxAge refreshes on every write and jobs die 24h after
//      CREATION. So a live cookie routinely holds a dead id, and the fallback
//      only fires when there is no cookie at all — the viewer lands on
//      "We couldn't find that job."
//   3. It bought a deep link the product does not otherwise offer, at the cost
//      of a second source of truth for "your jobs" beside /history.
//
// If a "jump to my latest job" affordance is wanted later, it must come from
// the viewer's OWN jobs, server-side and ownership-checked — not from this
// cookie.
import { getUser } from '@/lib/auth/supabase';
import SignedInNav from './SignedInNav';

export default async function SignedInChrome() {
  // The repo's one authenticated-read pattern (app/jobs/[id]/page.tsx:32).
  // It is awaited HERE, on the server, and handed down as a boolean — the nav
  // never touches auth. A thrown getUser (Supabase unreachable) must not take
  // a whole page down with it: the bar degrades to its signed-out face, which
  // is still a route out of every dead end.
  let signedIn = false;
  try {
    signedIn = (await getUser()) !== null;
  } catch (err) {
    // NEVER swallow Next's control-flow throws. `redirect()`, `notFound()`
    // and DynamicServerError are all signalled by THROWING, and all carry a
    // `digest`; a bare `catch {}` turns any of them into "signed out" and
    // loses the control flow. Re-throw anything Next owns, swallow only a
    // genuine Supabase failure.
    //
    // This re-throw is NOT what keeps these routes dynamic — measured, not
    // assumed: with it in place /history still prerendered as ○, because
    // @supabase/ssr reads the cookie jar behind its own error handling and no
    // DynamicServerError ever reaches here. That is why every one of these
    // seven layouts declares `dynamic = 'force-dynamic'` instead of relying on
    // Next inferring it. A statically prerendered segment would bake
    // `signedIn: false` into the HTML and serve a signed-in visitor a cached
    // "Sign in" bar.
    if (typeof (err as { digest?: unknown } | null)?.digest === 'string') throw err;
    signedIn = false;
  }

  return <SignedInNav signedIn={signedIn} />;
}
