import { NextRequest, NextResponse } from 'next/server';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { r2 } from '@/lib/r2';
import { presignTtlSec } from '@/lib/retention';
import { mintStemPlayUrl } from '@/lib/stem-urls';
import { PLAYABLE_STEMS, STEM_PLAY_PREFIX, stemNameFromPlayKey } from '@/lib/stem-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/jobs/:id/stems — the Opus playback stems for the play-along mixer (V3-J2).
//
// Returns one signed GET per retained stem, in mixer channel order. The browser
// fetches the audio direct from R2, exactly as it does for loops and the chord
// artifact: a stem must not be streamed through a Vercel function.
//
// Playback is Opus, not WAV, per TSD 12.2 — six WAV stems would be 240-360 MB into
// the browser against a measured Variant D budget of 287 MB. Opus is ~4-5 MB/stem.
// The WAV download artifact is a SEPARATE object and is not served here.
//
// Shape: { stems: [{ stem, signed_url }], expected, complete, expires_in_sec }
//   `complete` is false when fewer than all six stems are present. The client must
//   use it: silently playing a mix with an instrument missing is the failure mode
//   this field exists to prevent. Stem uploads are best-effort per stem so that a
//   failed upload cannot discard a completed separation and its loops.
//
//   404 when the job is missing, expired, or not yet complete.
//   200 with stems: [] for jobs that predate V3-J2 — not an error; the client falls
//     back to the loop view rather than presenting a broken transport.
//   502 STEM_LIST_FAILED when R2 cannot be listed. Deliberately loud: this is the
//     web tier's FIRST real network call to R2 (everything else only presigns,
//     which is offline), so the credential may lack ListBucket in an environment
//     where every offline test still passes. A silent empty 200 would look exactly
//     like "no stems" and hide a misconfiguration.
//
// Deliberately NOT gated on sign-in. Playing along in the browser is the free
// launch hook; it is the stem DOWNLOAD that requires an account (V3-J9). Note the
// residue, which is Jon's to accept: as with every other job route, the job UUID is
// the only credential, and the privacy notice says so. Six full-length stems
// reconstruct the whole track, where a 4-bar loop does not — a larger payload
// behind the same existing door, not a new door.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    // Same gate as GET /api/jobs/:id and the play-chords route.
    const jobRes = await db.query(
      `SELECT id, status, expires_at FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const job = jobRes.rows[0];
    if (job.status !== 'done') {
      return NextResponse.json({ error_code: 'NOT_READY', message: 'Job not yet complete' }, { status: 404 });
    }

    // Clamp the TTL to the job's own expiry. A URL minted at hour 23 must not
    // outlive the objects it points at — the loops route does the same, and a fixed
    // 900s would have handed out URLs that outlive the retention sweep.
    const expiresIn = presignTtlSec(job.expires_at);

    // List rather than derive-and-hope. All six stems are now retained regardless of
    // `requested_stems`, so the EXPECTED set is a constant; the list establishes what
    // actually landed, which is what `complete` reports.
    let listed;
    try {
      listed = await r2.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME!,
          Prefix: `${params.id}/${STEM_PLAY_PREFIX}`,
          MaxKeys: 50, // the prefix holds at most 6 objects; cannot under-report
        })
      );
    } catch (listErr) {
      Sentry.captureException(listErr, { tags: { route: 'api/jobs/[id]/stems', op: 'list' } });
      return NextResponse.json(
        { error_code: 'STEM_LIST_FAILED', message: 'Could not list stems' },
        { status: 502 }
      );
    }

    const present = new Set<string>();
    for (const obj of listed.Contents ?? []) {
      const name = obj.Key ? stemNameFromPlayKey(obj.Key) : null;
      if (name) present.add(name);
    }

    // Mixer channel order, not R2's lexical order.
    const stems = await Promise.all(
      PLAYABLE_STEMS.filter((s) => present.has(s)).map(async (stem) => ({
        stem,
        signed_url: await mintStemPlayUrl(params.id, stem, expiresIn),
      }))
    );

    return NextResponse.json({
      stems,
      expected: PLAYABLE_STEMS,
      complete: stems.length === PLAYABLE_STEMS.length,
      expires_in_sec: expiresIn,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/stems error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
