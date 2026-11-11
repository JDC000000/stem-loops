// The server half of the signed-in header: it reads the request, the nav
// renders it.
//
// MOUNTED BY: app/{account,jobs,history,login,pricing,success,trial}/layout.tsx
// — seven one-line layouts, one per signed-in subtree. See the comment in
// app/account/layout.tsx for why a layout per subtree rather than one route
// group, and test/signed-in-nav.test.mjs for the gate that fails when a
// routable page appears outside that set.
import { cookies } from 'next/headers';
import { getUser } from '@/lib/auth/supabase';
import { latestJobId } from '@/lib/history-cookie';
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
  } catch {
    signedIn = false;
  }

  // `/jobs/<id>` needs an id and a global bar has none. The signed `sl-history`
  // cookie already carries the viewer's recent job ids, newest first, so the
  // two product items point at a real page with no database round trip. With
  // no cookie — a new viewer, or one whose jobs have aged out — both fall back
  // to `/`, the tool, which is the honest destination: you cannot play along
  // with, or download loops from, a song you have not uploaded yet.
  let latest: string | null = null;
  try {
    latest = latestJobId(cookies().get('sl-history')?.value);
  } catch {
    latest = null;
  }

  return (
    <SignedInNav
      signedIn={signedIn}
      playHref={latest ? `/jobs/${latest}` : '/'}
      loopsHref={latest ? `/jobs/${latest}#loops` : '/'}
    />
  );
}
