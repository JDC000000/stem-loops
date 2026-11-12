import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { r2 } from '@/lib/r2';
import { getUser } from '@/lib/auth/supabase';
import { EntitlementError, enforceEntitlement } from '@/lib/billing/entitlements';
import { mintStemDownloadUrl } from '@/lib/stem-urls';
import {
  PLAYABLE_STEMS,
  STEM_SIGNED_URL_TTL_SEC,
  stemDownloadR2Key,
} from '@/lib/stem-keys';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A signed URL is a bearer credential; see the same constant in ../stems/route.ts.
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function bad(error_code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error_code, message }, { status, headers: NO_STORE });
}

// GET /api/jobs/:id/download?stem=<drums|bass|guitar|keys|vocals|other>
//
// The GATED half of TSD §12.2. Playback is Opus and stays open (../stems/route.ts, and
// ../play-chords); "The WAV download artifact is a SEPARATE object" —
// `<job>/_stems/dl/<stem>.wav` — and this is the only route that signs it. It is the
// consumer lib/stem-urls.ts:mintStemDownloadUrl was written for and never had.
//
// WHAT IS GATED, AND WHAT IS NOT
//   Gated here:  the full-length stem WAV (`_stems/dl/`).
//   NOT touched: Opus playback (../stems), the chord artifact (../play-chords), and the
//                per-loop WAVs GET /api/jobs/:id signs. The last is the Free plan's
//                advertised "Loop export" (pricing/page.tsx features()), so closing it is a
//                product decision, not a gate to add silently; see the PR description.
//
// ENTITLEMENT MAPPING (plans table: free {stems:f, wav24:f}, pro {t,f}, studio {t,t})
//   The route calls enforceEntitlement for BOTH `export_stems` and `export_wav24`, in that
//   order, and signs only if both pass. Today that means Studio only. `export_stems` is
//   checked as well as `export_wav24` so that a plan row with wav24 = true and stems =
//   false (an inconsistent edit to `plans`) fails closed instead of selling a
//   24-bit WAV to a plan that has no stem export.
//
// AUTH. `getUser()` (not `getSession()`), as ../loops/route.ts: a forged cookie must not
// pass an entitlement check. Signed out -> 401 before the job is looked up, so an anonymous
// caller learns nothing about whether a job or a plan exists.
//
// OWNERSHIP, same posture as ../loops/route.ts: a job with `user_id` set is downloadable
// only by that user (404, never 403, so an id probe cannot tell "someone else's" from
// "absent"); an anonymous job (`user_id` NULL) is addressed by its link, and the CALLER's
// plan is what is checked.
//
// NO LEAK. A denial returns the denied action's error_code and the entitlement layer's own
// message — facts about the CALLER's plan only. No snapshot, plan code or user id is echoed.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return bad('NOT_FOUND', 'Job not found', 404);
  try {
    const user = await getUser();
    if (!user) return bad('AUTH_REQUIRED', 'Sign in to download stems.', 401);

    const stem = new URL(request.url).searchParams.get('stem') ?? '';
    if (!(PLAYABLE_STEMS as readonly string[]).includes(stem)) {
      return bad('INVALID_STEM', `stem must be one of: ${PLAYABLE_STEMS.join(', ')}`, 400);
    }

    const jobRes = await db.query(
      `SELECT id::text AS id, user_id::text AS user_id, status, expires_at
         FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id],
    );
    if (jobRes.rowCount === 0) return bad('NOT_FOUND', 'Job not found', 404);
    const job = jobRes.rows[0];
    // Only a literal null opens a job to other signed-in users; a row that lost its
    // user_id column denies everyone rather than admitting everyone.
    if (job.user_id !== null && job.user_id !== user.user_id) {
      return bad('NOT_FOUND', 'Job not found', 404);
    }
    if (job.status !== 'done') return bad('NOT_READY', 'Job not yet complete', 404);

    try {
      await enforceEntitlement('export_stems', user.user_id);
      await enforceEntitlement('export_wav24', user.user_id);
    } catch (err) {
      if (err instanceof EntitlementError) {
        return bad(err.code, err.message, err.status);
      }
      throw err;
    }

    // Use the DB row's id (lowercase), not params.id, to build the key.
    const jobId: string = job.id;
    try {
      await r2.send(
        new HeadObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: stemDownloadR2Key(jobId, stem),
        }),
      );
    } catch (headErr) {
      const e = headErr as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
        return bad('STEM_NOT_FOUND', 'That stem is not available for download.', 404);
      }
      throw headErr;
    }

    // Never outlives the job, never longer than the stem ceiling; unparseable -> 1s.
    const remainingMs = new Date(job.expires_at).getTime() - Date.now();
    const remainingSec = Number.isFinite(remainingMs) ? Math.floor(remainingMs / 1000) : 1;
    const expiresIn = Math.min(STEM_SIGNED_URL_TTL_SEC, Math.max(1, remainingSec));

    const signed_url = await mintStemDownloadUrl(jobId, stem, expiresIn, `${stem}.wav`);
    return NextResponse.json(
      { stem, signed_url, expires_in_sec: expiresIn },
      { headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/download error:`, err);
    return bad('INTERNAL_ERROR', 'Internal server error', 500);
  }
}
