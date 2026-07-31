import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { presignPut } from '@/lib/r2';
import { validateUpload, MAX_UPLOAD_BYTES } from '@/lib/upload';
import { checkUploadRate, isLockTimeout, recordUploadIntent } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';

const RATE_LIMIT_MSG =
  "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.";

// POST /api/uploads — validate an intended upload and return a presigned PUT URL.
// The browser then uploads DIRECT to R2 (no bytes through this function), then
// calls POST /api/jobs with { jobId, uploadKey } to create the job.
export async function POST(request: NextRequest) {
  try {
    let payload: any;
    try {
      payload = await request.json();
    } catch {
      // Malformed JSON is a client error, not ours (QA P2 — was surfacing as a 500).
      return NextResponse.json(
        { error_code: 'UPLOAD_INVALID', message: 'Request body must be valid JSON.' },
        { status: 400 }
      );
    }
    const { filename, size } = payload ?? {};
    if (typeof filename !== 'string' || typeof size !== 'number') {
      return NextResponse.json(
        { error_code: 'UPLOAD_INVALID', message: 'filename and size are required.' },
        { status: 400 }
      );
    }

    // Per-IP throttle BEFORE minting a real 200MB R2 PUT credential (review BLOCKER #2).
    const clientIpHash = clientIpHashOf(request);
    const adm = await checkUploadRate(clientIpHash);
    if (!adm.allowed) {
      return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
    }

    const v = validateUpload(filename, size);
    if (!v.ok) {
      return NextResponse.json({ error_code: v.error_code, message: v.message }, { status: 400 });
    }

    // Key is under the {jobId}/ prefix — same as this job's loops — so the 7-day
    // active-TTL cleanup (T33) + R2 lifecycle backstop delete the uploaded source
    // alongside the outputs (PRD §6.1: no user content beyond TTL).
    const jobId = randomUUID();
    const key = `${jobId}/_input.${v.ext}`;

    // Record the intent BEFORE minting the credential (C1): POST /api/jobs will only
    // accept an uploadKey that appears here, bound to this job id, and only once. Doing
    // it first means we never hand out a PUT URL we can't subsequently honour.
    await recordUploadIntent(jobId, key, clientIpHash);

    const uploadUrl = await presignPut(key, v.contentType, size);

    return NextResponse.json({ jobId, key, uploadUrl, maxBytes: MAX_UPLOAD_BYTES, contentType: v.contentType });
  } catch (err) {
    // Giving up waiting on the per-IP rate lock means saturation, not a bug (see
    // lib/admission.ts) — answer 429, not a 500 + Sentry alert.
    if (isLockTimeout(err)) {
      return NextResponse.json({ error_code: 'RATE_LIMITED', message: RATE_LIMIT_MSG }, { status: 429 });
    }
    Sentry.captureException(err);
    console.error('POST /api/uploads error:', err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
