// /loops — the loop downloader as its own product page (Story 6).
//
// Jon, 2026-11-11: "loops downloader — available in top nav as 'download
// loops'. make it on a separate product page. only do the processing work to
// create loops when the user asks for the loops to be created." The "only on
// request" half shipped in #211 (migration 033); this is the page half. The job
// page (/jobs/[id]) no longer shows loops; it links here.
//
// SIGN-IN IS REQUIRED, by the one authenticated-page pattern in this repo
// (app/jobs/[id]/page.tsx): `await getUser()` then
// `redirect('/login?return_to=…')`. As there, the redirect protects the page
// only; the authorisation boundary is on the API routes the body calls
// (/api/jobs/:id, /api/jobs/:id/loops, /api/jobs/:id/stems).
//
// `?job=<id>` preselects a song (the job page's "Download loops" link uses it).
// Anything that is not a uuid is ignored rather than passed to the client.

import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import { jobIdFrom } from '@/lib/loops/availability';
import LoopsView from './LoopsView';
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
    const back = jobId ? `/loops?job=${jobId}` : '/loops';
    redirect(`/login?return_to=${encodeURIComponent(back)}`);
  }

  return <LoopsView initialJobId={jobId} />;
}
