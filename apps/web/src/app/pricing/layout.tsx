// Signed-in chrome for /pricing. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';
import { pageFor } from '@/lib/seo/pages';
import { pageMetadata } from '@/lib/seo/meta';

// P6 (Jon, 2026-11-17): /pricing is PUBLIC and INDEXABLE. It used to declare
// `robots: { index: false }` on the page; it is now in the page registry
// (lib/seo/pages.ts), so it is in the sitemap and llms.txt, and its metadata
// comes from that one entry, like /loops. Nothing private is in the head: the
// page shows plans and packs to everyone, and only the buy buttons differ by
// session.
// generateMetadata: the shared Open Graph image is a DB-17 chord claim, read at request time.
export function generateMetadata(): Metadata {
  return pageMetadata(pageFor('/pricing')!);
}

// The bar is session-aware, so this segment must never be prerendered: a
// static render would bake `signedIn: false` into the HTML and show a cached
// "Sign in" to a signed-in visitor. Next does NOT infer this on its own here
// (see SignedInChrome), so it is declared. Measured: without it /history built
// as ○ static; with it, ƒ.
export const dynamic = 'force-dynamic';

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
