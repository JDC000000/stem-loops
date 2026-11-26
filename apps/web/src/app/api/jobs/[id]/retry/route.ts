import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { checkAdmission, RATE_LIMIT, RATE_WINDOW_MS } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';
import { canonicalizeYoutubeUrl } from '@/lib/youtube-url';
import { getUser } from '@/lib/auth/supabase';
import {
  entitlementMessage,
  RATE_LIMITED_PER_CLIENT_MSG,
  LINK_CAP_CREDITS_DETAIL,
  RETRY_LIMIT_MSG,
  RETRY_COOLDOWN_MSG,
  UPLOAD_AGAIN_MSG,
  retryTrialUsedMessage,
} from '@/lib/error-copy';
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
import { consumeTrialInTx, TRIAL_SONG_CAP } from '@/lib/trial';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';
import { createAuthedLinkJob, type LinkJobDeps, type LinkJobResult, type ParentRestore } from '@/lib/jobs/create-link-job';
import { decideRetry, mirrorRestoreCharge, type RetryCandidate } from '@/lib/jobs/retry-policy';

// /api/jobs/:id/retry — "Try again" on a failed link song (#321; Phase B, B3).
//   GET:  may the caller retry this job, and what would it cost? Also the job's retry_of, so
//         a retry's page can link "Retry of <original>". Read-only.
//   POST: start the retry: a NEW job (retry_of = :id), funded by mirroring what the failure
//         gave back (lib/jobs/create-link-job.ts, funding mode mirror_restore), through every
//         gate a pasted link passes (ALLOW_YOUTUBE_INPUT, admission, burst; quota and the paid
//         entitlement when it spends a unit). The original stays failed.
// Owner only: anyone else, an anonymous job and a demo song get the same 404 as a missing job
// (lib/jobs/retry-policy.ts; the job-access rule for every non-read action is owner-only).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const NOT_FOUND = { error_code: 'NOT_FOUND', message: 'Job not found' } as const;
const NOT_RETRYABLE = {
  error_code: 'NOT_RETRYABLE',
  message: "This song can't be tried again. Start a new song instead.",
} as const;

type ParentRow = RetryCandidate & {
  id: string;
  youtube_url: string | null;
  requested_stems: string[] | null;
  loop_length_bars: number | null;
  retry_of: string | null;
};

// The job as the retry decision sees it. Past its retention (JOB_RETAINED_UNTIL_SQL) a job is
// gone, exactly as GET /api/jobs/:id treats it.
async function readJob(id: string): Promise<ParentRow | null> {
  const r = await db.query(
    `SELECT id, user_id, is_demo, input_kind, status, error_code, youtube_url, requested_stems,
            loop_length_bars, retry_of, retry_depth, retried_at, updated_at
       FROM jobs WHERE id = $1 AND ${JOB_RETAINED_UNTIL_SQL} > now()`,
    [id],
  );
  return (r.rows[0] as ParentRow | undefined) ?? null;
}

async function readRestore(id: string): Promise<ParentRestore | null> {
  try {
    const r = await db.query(
      `SELECT restored_at, allowance_restored, trial_restored FROM public.job_allowance_debits WHERE job_id = $1`,
      [id],
    );
    return (r.rows[0] as ParentRestore | undefined) ?? null;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '42P01') return null;
    throw err;
  }
}

/** The caller's trial, for a retry that would spend a trial song: 'active' | 'used' | 'none'. */
async function trialState(userId: string): Promise<'active' | 'used' | 'none'> {
  const r = await db.query(
    `SELECT songs_used, expires_at > now() AS live FROM public.trial_grants WHERE user_id = $1`,
    [userId],
  );
  const row = r.rows[0] as { songs_used: number; live: boolean } | undefined;
  if (!row || !row.live) return 'none'; // no trial, or expired: that part of the retry is free
  return row.songs_used < TRIAL_SONG_CAP ? 'active' : 'used';
}

async function retryChild(id: string): Promise<string | null> {
  const r = await db.query(`SELECT id FROM jobs WHERE retry_of = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

let allowanceDebitUnmigratedReported = false;
function noteAllowanceDebitRecorded(recorded: boolean): void {
  if (recorded || allowanceDebitUnmigratedReported) return;
  allowanceDebitUnmigratedReported = true;
  Sentry.captureException(
    new Error('job_allowance_debits is missing (migration 042 not applied): retry allowance is not restorable'),
  );
}

// The same dependencies POST /api/jobs hands the lib (app/api/jobs/route.ts linkJobDeps).
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

function respond(r: LinkJobResult) {
  if (r.raw) return new NextResponse(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  return NextResponse.json(r.body, { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  try {
    const user = await getUser();
    const job = await readJob(params.id);
    if (!job) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
    const d = decideRetry(job, user?.user_id ?? null);
    if (d.kind === 'not_found') return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
    const body: Record<string, unknown> = { action: d.kind, retry_of: job.retry_of ?? null };
    if (d.kind === 'eligible') {
      body.retries_left = d.retries_left;
      // Say what POST would do: a trial song is spent only from a live trial (expired → that
      // part is free), and a used-up trial refuses the retry (the lib's TRIAL_EXHAUSTED).
      const c = mirrorRestoreCharge(await readRestore(job.id));
      const trial = c.trialSong && user ? await trialState(user.user_id) : 'none';
      if (trial === 'used') {
        body.action = 'trial_used';
        body.message = retryTrialUsedMessage();
        delete body.retries_left;
      } else {
        body.charge = c.unit || trial === 'active' ? 'charged' : 'free';
      }
    }
    if (d.kind === 'cooldown') body.retry_after_s = d.retry_after_s;
    if (d.kind === 'already_retried') body.retried_by = await retryChild(job.id);
    return NextResponse.json(body, { status: 200, headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal error' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // CSRF: same-origin browser requests only, before anything is read or spent.
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) {
    return NextResponse.json({ error_code: BAD_ORIGIN, message: originRefusal }, { status: 403 });
  }
  if (!UUID_RE.test(params.id)) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  try {
    const user = await getUser();
    if (!user) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
    const job = await readJob(params.id);
    if (!job) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
    const d = decideRetry(job, user.user_id);
    switch (d.kind) {
      case 'not_found':
        return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
      case 'upload_again':
        return NextResponse.json({ error_code: 'UPLOAD_AGAIN', message: UPLOAD_AGAIN_MSG }, { status: 409, headers: NO_STORE });
      case 'none':
        return NextResponse.json(NOT_RETRYABLE, { status: 409, headers: NO_STORE });
      case 'already_retried': {
        const child = await retryChild(job.id);
        return child
          ? NextResponse.json({ id: child }, { status: 200, headers: NO_STORE })
          : NextResponse.json({ error_code: 'RETRY_LIMIT', message: RETRY_LIMIT_MSG }, { status: 429, headers: NO_STORE });
      }
      case 'cap_reached':
        return NextResponse.json({ error_code: 'RETRY_LIMIT', message: RETRY_LIMIT_MSG }, { status: 429, headers: NO_STORE });
      case 'cooldown':
        return NextResponse.json(
          { error_code: 'RATE_LIMITED', message: RETRY_COOLDOWN_MSG },
          { status: 429, headers: { ...NO_STORE, 'Retry-After': String(d.retry_after_s) } },
        );
      case 'eligible':
        break;
    }
    const stems = Array.isArray(job.requested_stems) && job.requested_stems.length ? job.requested_stems : undefined;
    const r = await createAuthedLinkJob(
      {
        user,
        url: job.youtube_url,
        stems,
        loopLengthBars: job.loop_length_bars ?? undefined,
        clientIpHash: () => clientIpHashOf(request),
        funding: { mode: 'mirror_restore', parentJobId: job.id, limitMessage: RETRY_LIMIT_MSG, trialUsedMessage: retryTrialUsedMessage() },
      },
      linkJobDeps(),
    );
    return respond(r);
  } catch (err) {
    Sentry.captureException(err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal error' }, { status: 500, headers: NO_STORE });
  }
}
