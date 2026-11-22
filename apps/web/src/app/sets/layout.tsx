// Signed-in chrome for /sets (set lists, #322). See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
import type { Metadata } from 'next';
import SignedInChrome from '@/components/chrome/SignedInChrome';

export const metadata: Metadata = { title: 'Set lists', robots: { index: false, follow: false } };

// The bar is session-aware: never prerender this segment (see app/history/layout.tsx).
export const dynamic = 'force-dynamic';

export default function SetsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
