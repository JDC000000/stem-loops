// /jobs/[id] — the play-along page (V3 Story 1).
//
// STORY 1.5 — SIGN-IN IS REQUIRED. Jon, 2026-11-10: "Right from the start,
// let's require sign in so we know who's using it." A signed-out visitor is
// redirected to /login before any of the job body renders, so THIS PAGE is
// unreachable without an account.
//
// THAT REDIRECT IS NOT AN AUTHORISATION BOUNDARY. It guards the HTML page and
// nothing behind it. GET /api/jobs/:id, /api/jobs/:id/stems and
// /api/jobs/:id/play-chords never call getUser(): anyone holding a job's link
// can fetch its metadata, a presigned URL per stem and the chord file with no
// account at all. That is disclosed to users in the "Links to jobs" section of
// the privacy page, and the stems route header records it as residue awaiting
// the owner's acceptance. Only /api/jobs/:id/loops checks ownership (a job with
// a user_id is readable by that user alone). Do not read this page's redirect
// as protecting the data.
//
// The gate is a verbatim copy of the ONE authenticated-page pattern this repo
// already has — `await getUser()` then `redirect('/login?return_to=…')`, as in
// src/app/account/page.tsx, src/app/account/delete/page.tsx and
// src/app/trial/page.tsx. No new auth mechanism, and nothing under
// src/app/auth/ or src/lib/auth/ is touched. (/history is NOT a precedent: its
// own header says "Anonymous history page … No login.")
//
// That gate is why this file is a Server Component and the body lives in
// ./JobView: `getUser()` reads cookies, which a client component cannot do,
// and the polling loop cannot live in a server component. src/app/trial/
// already pairs a gated server page with a colocated client child the same way.
//
// `force-dynamic` because the gate reads the session cookie on every request;
// the same line appears for the same reason on /account and /trial.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import JobView from './JobView';

export const metadata: Metadata = { title: 'Play along', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: { id: string } }) {
  const user = await getUser();
  if (!user) redirect(`/login?return_to=${encodeURIComponent(`/jobs/${params.id}`)}`);

  return <JobView id={params.id} />;
}
