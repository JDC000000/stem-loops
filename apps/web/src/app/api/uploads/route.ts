import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { presignPut } from '@/lib/r2';
import { validateUpload, MAX_UPLOAD_BYTES } from '@/lib/upload';
import { checkAnonUploadDailyRate, checkGlobalCapacity, checkUploadRate, recordAnonPresign } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';
import { RATE_LIMITED_PER_CLIENT_MSG, entitlementMessage } from '@/lib/error-copy';
import { getUser } from '@/lib/auth/supabase';
import { enforceEntitlement, EntitlementError } from '@/lib/billing/entitlements';
import { checkMonthlyQuota } from '@/lib/billing/rate-limit';
import { quotaRefusalBody } from '@/lib/jobs/create-link-job';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

// F72: checkUploadRate is a per-client limit only.
const RATE_LIMIT_MSG = RATE_LIMITED_PER_CLIENT_MSG;

// POST /api/uploads — validate an intended upload and return a presigned PUT URL.
// The browser then uploads DIRECT to R2 (no bytes through this function), then
// calls POST /api/jobs with { jobId, uploadKey } to create the job.
export async function POST(request: NextRequest) {
  // CSRF (QA track B, B-06): same-origin browser requests only, before the body or any
  // counter is touched. Minting a presigned PUT is a state change (an R2 write credential).
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) {
    return NextResponse.json({ error_code: BAD_ORIGIN, message: originRefusal }, { status: 403 });
  }
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
    const adm = await checkUploadRate(clientIpHashOf(request));
    if (!adm.allowed) {
      return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
    }

    // B8 / product-plan 4.5: if the site is already at its global in-flight cap, say so
    // NOW, before the browser spends minutes PUTting up to 200 MB to R2 only for
    // POST /api/jobs to refuse it. Advisory: the queue can still fill between presign and
    // job creation, and POST /api/jobs re-checks (checkAdmission) authoritatively. Runs
    // AFTER the per-IP presign throttle so a flood can't turn this COUNT into an
    // unthrottled query.
    const cap = await checkGlobalCapacity();
    if (!cap.allowed && cap.error_code === 'AT_CAPACITY') {
      return NextResponse.json(
        { error_code: cap.error_code, message: cap.message },
        { status: 503, headers: { 'Retry-After': String(cap.retry_after_s) } },
      );
    }

    const v = validateUpload(filename, size);
    if (!v.ok) {
      return NextResponse.json({ error_code: v.error_code, message: v.message }, { status: 400 });
    }

    // QA track B, B-05: a SIGNED-OUT caller also has a per-IP DAILY presign cap
    // (lib/admission.ts checkAnonUploadDailyRate). Last gate before minting, so a refused,
    // invalid or at-capacity request never spends a unit of it. Signed-in callers are
    // metered at job creation by plan quota or credits (checked early, read-only, above).
    const user = await getUser();
    if (user) {
      // Beta QA S12 / QW-5 (#489): a signed-in caller out of songs (or credits) is told NOW,
      // before the browser PUTs up to 200 MB to R2, not after, when POST /api/jobs refuses it.
      // The same two read-only gates and the same 402 bodies as the upload path of POST
      // /api/jobs. Advisory: POST /api/jobs re-checks both authoritatively and owns the counted
      // boundary. checkBurstLimit is NOT called here: it records a start attempt, and a
      // presign is not a start.
      try {
        const { snapshot } = await enforceEntitlement('start_job_upload', user.user_id);
        const quota = await checkMonthlyQuota(user.user_id);
        if (quota) {
          const paid = snapshot.plan_code === 'pro' || snapshot.plan_code === 'studio';
          return NextResponse.json(quotaRefusalBody(quota.resets_at, paid, entitlementMessage), { status: 402 });
        }
      } catch (err) {
        if (err instanceof EntitlementError) {
          return NextResponse.json(
            { error_code: err.code, message: entitlementMessage(err.code, err.message) },
            { status: err.status },
          );
        }
        throw err;
      }
    } else {
      const daily = await checkAnonUploadDailyRate(clientIpHashOf(request));
      if (!daily.allowed) {
        return NextResponse.json(
          { error_code: daily.error_code, message: 'message' in daily ? daily.message : RATE_LIMIT_MSG },
          { status: 429 },
        );
      }
    }

    // Key is under the {jobId}/ prefix — same as this job's loops — so the 24-hour
    // retention sweep (T33) + R2 lifecycle backstop delete the uploaded source
    // alongside the outputs (PRD §6.1: no user content beyond TTL).
    const jobId = randomUUID();
    const key = `${jobId}/_input.${v.ext}`;
    const uploadUrl = await presignPut(key, v.contentType, size);
    // PR #300 review MF-2: a signed-out job may only be created for an upload key minted HERE,
    // for this IP hash. POST /api/jobs checks this record inside its locked INSERT.
    if (!user) await recordAnonPresign(clientIpHashOf(request), jobId);

    return NextResponse.json({ jobId, key, uploadUrl, maxBytes: MAX_UPLOAD_BYTES, contentType: v.contentType });
  } catch (err) {
    Sentry.captureException(err);
    console.error('POST /api/uploads error:', err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Something went wrong on our end. Please try again.' }, { status: 500 });
  }
}
