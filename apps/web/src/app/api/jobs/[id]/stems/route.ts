import { NextRequest, NextResponse } from 'next/server';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { r2 } from '@/lib/r2';
import { mintStemSignedUrl } from '@/lib/stem-urls';
import { PLAYABLE_STEMS, STEM_SIGNED_URL_TTL_SEC } from '@/lib/stem-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/jobs/:id/stems — the full-length stems for the play-along mixer (V3-J2).
//
// Returns one short-TTL signed GET URL per retained stem. The browser fetches the
// audio direct from R2, exactly as it does for loops and the chord artifact: a
// 40-60 MB stem must not be streamed through a Vercel function, and six of them
// certainly must not.
//
// Shape: { stems: [{ stem, signed_url, bytes }], expires_in_sec } on 200.
//        404 when the job is missing, expired, or not yet complete.
//        200 with stems: [] when the job predates V3-J2 — the mixer treats that
//          as "no stems for this job" and falls back to the loop view rather than
//          showing a broken transport. An empty list is NOT an error.
//
// Deliberately NOT gated on sign-in. Playing along in the browser is the free
// launch hook; it is the stem DOWNLOAD that requires an account (V3-J9) and is
// metered at 3 free. Gating playback here would gate the product itself.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    // Same gate as GET /api/jobs/:id and the play-chords route: the job row must
    // exist and still be inside its retention window.
    const jobRes = await db.query(
      `SELECT id, status FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    if (jobRes.rows[0].status !== 'done') {
      return NextResponse.json({ error_code: 'NOT_READY', message: 'Job not yet complete' }, { status: 404 });
    }

    // List rather than derive. The retained set is `requested_stems` UNION the
    // harmonic stems the chord stage pulls in regardless of what the user toggled,
    // so recomputing it here would duplicate pipeline logic and drift from it.
    // One ListObjectsV2 against a six-object prefix is cheap and authoritative.
    const listed = await r2.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME!,
        Prefix: `${params.id}/_stems/`,
        MaxKeys: 50,
      })
    );

    const sizeByStem = new Map<string, number>();
    for (const obj of listed.Contents ?? []) {
      const name = obj.Key?.split('/').pop()?.replace(/\.wav$/, '');
      if (name) sizeByStem.set(name, obj.Size ?? 0);
    }

    // Emit in PLAYABLE_STEMS order (mixer channel order), not R2's lexical order.
    const stems = await Promise.all(
      PLAYABLE_STEMS.filter((s) => sizeByStem.has(s)).map(async (stem) => ({
        stem,
        signed_url: await mintStemSignedUrl(params.id, stem),
        bytes: sizeByStem.get(stem) ?? 0,
      }))
    );

    return NextResponse.json({ stems, expires_in_sec: STEM_SIGNED_URL_TTL_SEC });
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/stems error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
