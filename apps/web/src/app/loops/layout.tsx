// Signed-in chrome for /loops. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
import SignedInChrome from '@/components/chrome/SignedInChrome';

// The bar is session-aware, so this segment must never be prerendered: a
// static render would bake `signedIn: false` into the HTML and show a cached
// "Sign in" to a signed-in visitor. Next does NOT infer this on its own here
// (see SignedInChrome), so it is declared — and test/signed-in-nav.test.mjs
// reads it off the compiled module rather than grepping for the string.
export const dynamic = 'force-dynamic';

export default function LoopsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
