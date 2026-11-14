// Signed-in chrome for /account, /account/delete and /account/reset-password.
//
// WHERE THE BAR IS MOUNTED, AND WHAT WAS REJECTED.
//
// CHOSEN — one tiny layout per signed-in subtree (this file and six siblings:
// jobs, history, login, pricing, success, trial). A layout is inherited by
// every page beneath it, so /account, /account/delete and /account/reset-password
// are all covered by this one file, and any page added under those subtrees
// later gets the bar without anyone remembering to add it.
//
// REJECTED — a new `app/(app)/` route group with a single layout. That is the
// tidier end state and it is what I would do on a quiet tree. It is wrong
// TODAY because it means git-moving nine page files, and app/jobs/[id]/ alone
// is open in several concurrent branches (the play-along engine, mixer,
// transport, chord-playhead and section-loop work). A move renames the file
// out from under every one of them and turns a 60-line navigation change into
// a merge conflict in work that has nothing to do with navigation. The group
// is a good follow-up once that lands; the comment is left here so the next
// person knows it was considered rather than missed.
//
// REJECTED — mounting in the ROOT layout (app/layout.tsx). It wraps the
// (landing) group too, so the landing, /terms, /privacy and the 404 would get
// BOTH this bar and SiteHeader. Those are the four pages this change is
// forbidden to alter.
//
// REJECTED — per-page mounting. No file moves either, but it drifts: a new
// page is a dead end until somebody notices. A layout cannot be forgotten.
//
// DELIBERATELY LEFT OUT — app/(landing)/* keeps SiteHeader; app/api/* and
// app/auth/callback are route handlers with no UI; error.tsx, global-error.tsx
// and not-found.tsx are framework error boundaries (not-found already renders
// SiteHeader, and global-error replaces the <html> element, so a layout above
// it does not apply). test/signed-in-nav.test.mjs enumerates app/ and fails on
// any routable page outside this set.
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';

// SEO-02: covers /account/delete and /account/reset-password, which set no robots of their own.
export const metadata: Metadata = { robots: { index: false, follow: false } };

// The bar is session-aware, so this segment must never be prerendered: a
// static render would bake `signedIn: false` into the HTML and show a cached
// "Sign in" to a signed-in visitor. Next does NOT infer this on its own here
// (see SignedInChrome), so it is declared. Measured: without it /history built
// as ○ static; with it, ƒ.
export const dynamic = 'force-dynamic';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
