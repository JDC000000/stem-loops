// /loops — the loop downloader as its own product page (Story 6).
//
// Jon, 2026-11-11: "loops downloader — available in top nav as 'download
// loops'. make it on a separate product page. only do the processing work to
// create loops when the user asks for the loops to be created." The "only on
// request" half shipped in #211 (migration 033); this is the page half. The job
// page (/jobs/[id]) no longer shows loops; it links here.
//
// SIGNED OUT (2026-11-15): bare /loops is now the Download loops PRODUCT PAGE
// (components/loops/LoopsIntro.tsx) — the top nav offers this product on every
// page, the landing included, so a signed-out visitor arriving here gets told
// what it is, with sign-in one click on and a return path back. The intro reads
// no job and calls no API.
//
// SIGNED OUT WITH ?job=<id>: still redirected to sign-in, by the one
// authenticated-page pattern in this repo (app/jobs/[id]/page.tsx):
// `await getUser()` then `redirect('/login?return_to=…')`. That link comes from
// a job page, so the visitor already knows the product and wants that song.
// As there, the redirect protects the page only; the authorisation boundary is
// on the API routes the body calls (/api/jobs/:id, /api/jobs/:id/loops,
// /api/jobs/:id/stems).
//
// `?job=<id>` preselects a song (the job page's "Download loops" link uses it).
// Anything that is not a uuid is ignored rather than passed to the client.

import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import { jobIdFrom } from '@/lib/loops/availability';
import LoopsView from './LoopsView';
import LoopsIntro from '@/components/loops/LoopsIntro';
// Imported HERE rather than inside LoopsView so the client component's module
// graph is TypeScript only and can be compiled into node by the tests. Next
// bundles a global stylesheet imported from a page the same way. (Same choice
// PR #208 made, for the same reason.)
import '@/styles/loops-page.css';

export const dynamic = 'force-dynamic';

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LoopsPage({
  searchParams,
}: {
  searchParams?: { job?: string | string[] };
}) {
  const raw = Array.isArray(searchParams?.job) ? searchParams?.job[0] : searchParams?.job;
  const jobId = raw && UUID_ONLY.test(raw) ? jobIdFrom(raw) : null;

  const user = await getUser();
  if (!user) {
    if (!jobId) return <LoopsIntro />;
    redirect(`/login?return_to=${encodeURIComponent(`/loops?job=${jobId}`)}`);
  }

  return <LoopsView initialJobId={jobId} />;
}
