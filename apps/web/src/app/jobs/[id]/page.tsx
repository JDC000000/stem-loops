// /jobs/[id] — the play-along page (V3 Story 1).
//
// STORY 1.5 — SIGN-IN IS REQUIRED. Jon, 2026-11-10: "Right from the start,
// let's require sign in so we know who's using it." A signed-out visitor is
// redirected to /login before any of the job body renders, so the player is
// unreachable without an account.
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
