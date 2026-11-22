// /jobs/[id]: marks the song as last opened on this browser for the library's Recent sort
// (Phase B, B1). Nothing else: the page, its metadata and its data are page.tsx's.
import { LastOpenedMarker } from '@/components/library/LastOpenedMarker';

// The job page is per-session already (app/jobs/layout.tsx's signed-in bar); say so for this
// segment too, so it is never prerendered (test/signed-in-nav.test.mjs).
export const dynamic = 'force-dynamic';

export default function JobLayout({ children, params }: { children: React.ReactNode; params?: { id?: string } }) {
  return (
    <>
      {children}
      {params?.id ? <LastOpenedMarker jobId={params.id} /> : null}
    </>
  );
}
