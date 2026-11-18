// /demo/<slug> — a demo song in the real player, for anyone, signed out included
// (Slice 2a; design v1.5 P3.1/P4; DB-12a). e.g. /demo/lucky-ticket.
//
// The slug resolves ONLY among `is_demo` rows (lib/demo-songs.ts), so this route can never
// open an ordinary job; a slug that is not a playable demo is a 404. It renders the same
// client body as /jobs/<id> (JobView), whose reads go through the API routes' own rule
// (lib/job-access.ts) — this page is a convenience URL, not an authorisation boundary.
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import { resolveDemo } from '@/lib/demo-songs';
import JobView from '../../jobs/[id]/JobView';

export const metadata: Metadata = { title: 'Play along: demo song', robots: { index: false, follow: false } };
// Reads the session (back arrow: library or home) and the demo rows on every request.
export const dynamic = 'force-dynamic';
// The player pads itself with the safe-area insets; see app/jobs/[id]/page.tsx.
export const viewport: Viewport = { viewportFit: 'cover' };

export default async function DemoPage({ params }: { params: { slug: string } }) {
  const demo = await resolveDemo(params.slug);
  if (!demo) notFound();
  const user = await getUser();
  return <JobView id={demo.id} signedIn={user !== null} />;
}
