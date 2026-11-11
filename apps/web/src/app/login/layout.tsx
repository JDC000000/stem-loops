// Signed-in chrome for /login. See app/account/layout.tsx for why the bar is
// mounted as one small layout per subtree rather than one route group.
import SignedInChrome from '@/components/chrome/SignedInChrome';

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
