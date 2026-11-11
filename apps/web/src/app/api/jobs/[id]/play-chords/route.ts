import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { mintPlayChordsSignedUrl, PLAY_CHORDS_SIGNED_URL_TTL_SEC } from '@/lib/r2';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/jobs/:id/play-chords — short-TTL signed URL for the Y1 chord artifact.
//
// The bucket is private; the worker writes jobs/<id>/play.chords.json after a
// successful Klangio (or future internal) recognition pass. The browser overlay
// in completed-job mode calls this to obtain a 5-minute signed GET URL and then
// fetches the JSON directly from R2 (saves Vercel egress; matches how /api/jobs
// returns a signed_url per loop rather than streaming bytes through the server).
//
// Shape: { signed_url, expires_in_sec } on 200.
//        404 when the job doesn't exist, has expired, or hasn't produced chords.
//          (A missing R2 object vs a missing job collapses to the same 404 — the
//           loader treats it as "no chord data for this job" either way.)
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    // Gate on the job row existing + not expired, same rule as GET /api/jobs/:id.
    // We do NOT HEAD R2 to confirm the object is present — on a happy path the
    // extra round trip doubles the API latency; on a cold-cache miss the browser
    // just gets a 404 from R2 directly and the loader returns null.
    const jobRes = await db.query(
      `SELECT id, status FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    // Only completed jobs will have a play.chords.json — surface a 404 for
    // not-yet-done jobs so the client doesn't mint a URL it will race against.
    if (jobRes.rows[0].status !== 'done') {
      return NextResponse.json({ error_code: 'NOT_READY', message: 'Job not yet complete' }, { status: 404 });
    }
    const signed_url = await mintPlayChordsSignedUrl(params.id);
    // This body carries a BEARER CREDENTIAL (a presigned R2 URL), so it must
    // never land in a shared cache that could replay it to another caller.
    // Next's default on this route was `public, max-age=0, must-revalidate`,
    // which permits a shared cache to store it; `must-revalidate` governs
    // staleness, not storage. Found by a production QA sweep on 2026-11-11,
    // which observed the public header live on this route while the sibling
    // stems route correctly sent `private, no-store`. Matching that here.
    return NextResponse.json(
      { signed_url, expires_in_sec: PLAY_CHORDS_SIGNED_URL_TTL_SEC },
      { headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/play-chords error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
