// POST /api/library/remake {entry_id} — make an expired library song playable again
// (Phase B, B1; US 5.3; PB-2: a Re-make COUNTS AS A MONTHLY SONG, Jon).
//
// ORDER: same-origin guard -> getUser() -> the caller's entry (404 if it is not theirs) ->
// an upload entry is 409 "Upload again" (there is nothing to re-fetch) -> B0's
// createAuthedLinkJob() with the entry's link, so EVERY gate a pasted link passes applies
// (ALLOW_YOUTUBE_INPUT, admission/capacity, trial, burst, monthly quota, per-IP limit) and
// exactly one monthly (or trial) song is spent and recorded in job_allowance_debits (migration
// 042, so an our-fault failure gives it back like any link job).
//
// NO DOUBLE CHARGE (lib/library-server.ts remakeHooks):
//   findExisting  the newest live job of this user + URL (done and retained, or in flight):
//                 200 { id } with nothing spent (a second tap, or a Re-make while queued).
//   beforeInsert  locks the entry row FOR UPDATE in the insert tx and repeats the lookup, so
//                 two concurrent Re-makes make one job and one debit.
// Neither hook writes the entry; the job's expires_at is the INSERT default (Free's 24 h, or
// the paid library rule read at serve time). Refusals keep the status and body the job lib gives
// (its copy comes from lib/error-copy.ts); nothing new is added there.
//
// Errors: 400 INVALID_REQUEST · 401 AUTH_REQUIRED · 403 BAD_ORIGIN / DOWNLOAD_INVALID_URL
//         (links paused) · 404 NOT_FOUND · 409 UPLOAD_AGAIN · 402 / 429 / 503 from the gates ·
//         500 INTERNAL_ERROR
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { checkAdmission, RATE_LIMIT, RATE_WINDOW_MS } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';
import { canonicalizeYoutubeUrl } from '@/lib/youtube-url';
import { getUser } from '@/lib/auth/supabase';
import { entitlementMessage, RATE_LIMITED_PER_CLIENT_MSG, LINK_CAP_CREDITS_DETAIL } from '@/lib/error-copy';
import {
  checkBurstLimit,
  checkMonthlyQuota,
  bumpJobsUsed,
  bumpJobsUsedWithinQuota,
  recordAllowanceDebit,
  rollPeriodIfStale,
} from '@/lib/billing/rate-limit';
import {
  getEntitlementSnapshot,
  enforceEntitlement,
  EntitlementError,
  FREE_QUOTA_EXHAUSTED_MESSAGE,
} from '@/lib/billing/entitlements';
import { consumeTrialInTx } from '@/lib/trial';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { createAuthedLinkJob, type LinkJobDeps } from '@/lib/jobs/create-link-job';
import { EntryGone, getOwnedEntry, remakeHooks } from '@/lib/library-server';
import { UPLOAD_AGAIN_MSG } from '@/lib/library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RemakeResponse = { id: string; status?: 'queued' };

// QA-64 (same as POST /api/jobs): say once per process when 042 is missing.
let allowanceDebitUnmigratedReported = false;
function noteAllowanceDebitRecorded(recorded: boolean): void {
  if (recorded || allowanceDebitUnmigratedReported) return;
  allowanceDebitUnmigratedReported = true;
  Sentry.captureException(
    new Error('job_allowance_debits is missing (migration 042 not applied): link-job allowance is not restorable'),
  );
}

// The same dependencies POST /api/jobs hands the lib (its linkJobDeps()).
function linkJobDeps(): LinkJobDeps {
  return {
    db,
    randomUUID,
    canonicalizeYoutubeUrl,
    checkAdmission,
    RATE_LIMIT,
    RATE_WINDOW_MS,
    checkBurstLimit,
    checkMonthlyQuota,
    bumpJobsUsed,
    bumpJobsUsedWithinQuota,
    recordAllowanceDebit,
    rollPeriodIfStale,
    getEntitlementSnapshot,
    enforceEntitlement,
    EntitlementError,
    FREE_QUOTA_EXHAUSTED_MESSAGE,
    LINK_CAP_CREDITS_DETAIL,
    RATE_LIMIT_MSG: RATE_LIMITED_PER_CLIENT_MSG,
    entitlementMessage,
    consumeTrialInTx,
    captureException: (err: unknown) => Sentry.captureException(err),
    noteAllowanceDebitRecorded,
  };
}

const fail = (status: number, error_code: string, message: string) =>
  NextResponse.json({ error_code, message }, { status, headers: NO_STORE });
const notFound = () => fail(404, 'NOT_FOUND', 'That song is no longer in your library.');

export async function POST(request: NextRequest) {
  const refusal = crossOriginRefusal(request);
  if (refusal) return fail(403, BAD_ORIGIN, refusal);
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to re-make a song.');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }
    const entryId = (body as { entry_id?: unknown } | null)?.entry_id;
    if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) return notFound();

    const entry = await getOwnedEntry(db, user.user_id, entryId);
    if (!entry) return notFound();
    if (!entry.youtube_url) return fail(409, 'UPLOAD_AGAIN', UPLOAD_AGAIN_MSG);

    let r;
    try {
      r = await createAuthedLinkJob(
        { user, url: entry.youtube_url, clientIpHash: () => clientIpHashOf(request), ...remakeHooks(entryId, user.user_id) },
        linkJobDeps(),
      );
    } catch (err) {
      if (err instanceof EntryGone) return notFound();
      throw err;
    }
    // The lib's refusal bodies carry their own sentence (QW-1: quotaRefusalBody /
    // burstRefusalBody), so the body is returned as it is (#489: the old back-fill was dead).
    return NextResponse.json(r.body, { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
  } catch (err) {
    Sentry.captureException(err);
    console.error('POST /api/library/remake error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not re-make that song. Please try again.');
  }
}
