import { NextRequest, NextResponse } from 'next/server';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { r2 } from '@/lib/r2';
import { presignTtlSec } from '@/lib/retention';
import { mintStemPlayUrl } from '@/lib/stem-urls';
import {
  PLAYABLE_STEMS,
  STEM_PREFIX,
  STEM_SIGNED_URL_TTL_SEC,
  stemNameFromPlayKey,
  stemNameFromDownloadKey,
  stemState,
} from '@/lib/stem-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/jobs/:id/stems — the Opus playback stems for the play-along mixer (V3-J2).
//
// Returns one signed GET per retained stem, in mixer channel order. The browser
// fetches the audio direct from R2, exactly as it does for loops and the chord
// artifact: a stem must not be streamed through a Vercel function.
//
// Playback is Opus, not WAV, per TSD §12.2 — six WAV stems would be 240-360 MB into
// the browser against a measured Variant D budget of 287 MB. Opus is ~4-5 MB/stem.
// The WAV download artifact is a SEPARATE object and is not served here.
//
// Shape: { stems: [{ stem, signed_url }], expected, complete, state, expires_in_sec }
//
// `state` exists because `complete: false` alone hid a real failure. An adversarial
// review demonstrated that if Opus encoding fails for EVERY stem, the job still
// reports `done`, six WAVs upload, and this route returned `{stems: [], complete:
// false}` — which the previous version's own comment defined as "a job that predates
// V3-J2, not an error". Broken and legacy were indistinguishable. The two are told
// apart by whether the DOWNLOAD artifacts exist:
//   'unavailable'   no stems of either kind -> pre-V3-J2 job; fall back to loops
//   'ready'         all six playable
//   'partial'       some playable -> a mix with an instrument missing; do not autoplay
//   'encode_failed' downloads exist, nothing playable -> the ENCODER failed; alertable
//
//   404 when the job is missing, expired, or not yet complete.
//   502 STEM_LIST_FAILED when R2 cannot be listed. Deliberately loud: this is the
//     web tier's first real network call to R2 (everything else only presigns, which
//     is offline), so a credential could lack ListBucket in an environment where
//     every offline test passes. A silent empty 200 would look exactly like "no
//     stems". (Confirmed working in production 2026-11-10: a live done job returned
//     200 with an empty list rather than an error.)
//
// Deliberately NOT gated on sign-in. Playing along in the browser is the free launch
// hook; it is the stem DOWNLOAD that requires an account (V3-J9).
//
// ⚠️ RESIDUE REQUIRING JON'S RECORDED ACCEPTANCE (M-11): as with every other job
// route, the job UUID is the only credential, and the privacy notice says so. But
// six full-length stems reconstruct the WHOLE track where a 4-bar loop does not.
// That is a larger exposure behind the same existing door, and a code comment is not
// acceptance.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    // Same gate as GET /api/jobs/:id and the play-chords route.
    const jobRes = await db.query(
      `SELECT id::text AS id, status, expires_at FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const job = jobRes.rows[0];
    if (job.status !== 'done') {
      return NextResponse.json({ error_code: 'NOT_READY', message: 'Job not yet complete' }, { status: 404 });
    }

    // Use the DB row's id, NOT params.id, to build the R2 prefix. UUID_RE is
    // case-insensitive, so an uppercase UUID passes the lookup (Postgres `uuid`
    // comparison is case-insensitive) and would then list a prefix that does not
    // exist, returning a silent empty list. Postgres renders uuid as lowercase.
    const jobId: string = job.id;

    // Clamp the TTL twice over. presignTtlSec alone would hand out URLs valid for up
    // to 24h, and TSD §12.2 says "short-TTL signed GETs"; the earlier fix traded one
    // bug (outliving the objects) for another (a 24h stem URL). min() keeps both
    // properties: never longer than 15 min, never past the job's own expiry.
    const expiresIn = Math.min(STEM_SIGNED_URL_TTL_SEC, presignTtlSec(job.expires_at));

    // ONE list over the shared `_stems/` parent covers both artifact kinds, which is
    // what makes `encode_failed` distinguishable from `unavailable`.
    let listed;
    try {
      listed = await r2.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME!,
          Prefix: `${jobId}/${STEM_PREFIX}`,
          MaxKeys: 100, // at most 12 objects live here; cannot under-report
        })
      );
    } catch (listErr) {
      Sentry.captureException(listErr, { tags: { route: 'api/jobs/[id]/stems', op: 'list' } });
      return NextResponse.json(
        { error_code: 'STEM_LIST_FAILED', message: 'Could not list stems' },
        { status: 502 }
      );
    }

    const playable = new Set<string>();
    const downloadable = new Set<string>();
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      const play = stemNameFromPlayKey(obj.Key);
      if (play) {
        playable.add(play);
        continue;
      }
      const dl = stemNameFromDownloadKey(obj.Key);
      if (dl) downloadable.add(dl);
    }

    const state = stemState(playable.size, downloadable.size);
    if (state === 'encode_failed') {
      // The worker already reports this, but a job retained before that logging
      // existed would otherwise be invisible. Cheap, and it fires at most once per
      // request on an already-broken job.
      Sentry.captureMessage(
        `V3-J2 encode_failed: ${downloadable.size} downloads, 0 playable for job ${jobId}`,
        'error'
      );
    }

    // Mixer channel order, not R2's lexical order.
    const stems = await Promise.all(
      PLAYABLE_STEMS.filter((s) => playable.has(s)).map(async (stem) => ({
        stem,
        signed_url: await mintStemPlayUrl(jobId, stem, expiresIn),
      }))
    );

    return NextResponse.json({
      stems,
      expected: PLAYABLE_STEMS,
      complete: state === 'ready',
      state,
      expires_in_sec: expiresIn,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/stems error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
