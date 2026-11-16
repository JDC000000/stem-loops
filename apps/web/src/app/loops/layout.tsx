// Signed-in chrome for /loops. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
// (Shape reused from PR #208, which was closed unmerged on 2026-11-12.)
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';
import { pageFor } from '@/lib/seo/pages';
import { pageMetadata } from '@/lib/seo/meta';

// SEO (#271 rules): /loops is a PUBLIC product page since 2026-11-15 — signed out it renders the
// Download loops intro, which is what a crawler sees — so it is in the page registry
// (lib/seo/pages.ts), the sitemap and llms.txt, and indexable. Its metadata comes from that one
// registry entry, like /privacy and /terms. A signed-in visitor gets the same URL with their
// songs on it; nothing private is in the head.
export const metadata: Metadata = pageMetadata(pageFor('/loops')!);

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
