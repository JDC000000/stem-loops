// Chrome for /demo/<slug> (Slice 2a), the same as /jobs: see app/jobs/layout.tsx. The
// player covers it while it is mounted; the bar is there for the moments it is not.
import SignedInChrome from '@/components/chrome/SignedInChrome';

// Session-aware bar: never prerendered (see app/jobs/layout.tsx).
export const dynamic = 'force-dynamic';

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedInChrome />
      {children}
    </>
  );
}
