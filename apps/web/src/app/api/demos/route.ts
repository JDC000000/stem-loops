// GET /api/demos — the playable demo songs (Slice 2a; design v1.5 P3.1, P4).
//
// Shape: { demos: [{ id, slug, title, artist, bpm, musical_key }] }
//
// Called by the home page's live demo only after a visitor taps Play (P4.2: nothing loads
// until then). It carries no credential: no signed URL, no user_id — only the ids of the
// three demo songs, which every visitor may read anyway (lib/job-access.ts). So, unlike
// the job routes, it MAY be cached by a shared cache, which is what keeps it off the
// database under load: one read per edge per 5 minutes. It writes nothing.
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { listDemoJobs } from '@/lib/demo-songs';

export const dynamic = 'force-dynamic';

const DEMOS_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600';

export async function GET() {
  try {
    const demos = await listDemoJobs();
    return NextResponse.json({ demos }, { headers: { 'Cache-Control': DEMOS_CACHE_CONTROL } });
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/demos error:', err);
    return NextResponse.json(
      { error_code: 'INTERNAL_ERROR', message: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
