// /jobs/[id] — the play-along page (V3 Story 1).
//
// STORY 1.5 — SIGN-IN IS REQUIRED. Jon, 2026-11-10: "Right from the start,
// let's require sign in so we know who's using it." A signed-out visitor is
// redirected to /login before any of the job body renders, so THIS PAGE is
// unreachable without an account.
//
// A PAGE-LEVEL REDIRECT PROTECTS NOTHING BUT THE PAGE. It is not an authorisation
// boundary and must never be read as one. Every byte the player shows comes from
// /api/jobs/:id, /api/jobs/:id/stems and /api/jobs/:id/play-chords, which a caller can
// request directly without ever loading this page; before SEC-1 those three never
// called getUser(), and an unauthenticated GET returned 200 with 60 presigned R2 URLs
// (a 1-byte range request to one returned 206 audio/wav). The check that matters is on
// those routes, not here: src/lib/job-access.ts — a job with a user_id is served to
// that user alone (404 for anyone else), a job with user_id NULL (started without an
// account) is served to anyone holding its id. test/job-access-routes.test.mjs runs the
// real routes. Presigned URLs already issued cannot be recalled; they expire on their own.
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
