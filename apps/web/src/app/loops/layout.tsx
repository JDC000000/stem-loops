// Signed-in chrome for /loops. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
// (Shape reused from PR #208, which was closed unmerged on 2026-11-12.)
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';

export const metadata: Metadata = { title: 'Download loops', robots: { index: false, follow: false } };

// The bar is session-aware, so this segment must never be prerendered: a
// static render would bake `signedIn: false` into the HTML and show a cached
// "Sign in" to a signed-in visitor. test/signed-in-nav.test.mjs reads this off
// the compiled module.
export const dynamic = 'force-dynamic';

export default function LoopsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
