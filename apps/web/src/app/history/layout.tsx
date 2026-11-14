// Signed-in chrome for /history. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';

export const metadata: Metadata = { title: 'Job history', robots: { index: false, follow: false } };

// The bar is session-aware, so this segment must never be prerendered: a
// static render would bake `signedIn: false` into the HTML and show a cached
// "Sign in" to a signed-in visitor. Next does NOT infer this on its own here
// (see SignedInChrome), so it is declared. Measured: without it /history built
// as ○ static; with it, ƒ.
export const dynamic = 'force-dynamic';

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
