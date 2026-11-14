// POST /api/jobs/:id/loops — ask for this job's loops to be cut.
// GET  /api/jobs/:id/loops — poll the live request, if any.
//
// Migration 033. The pipeline records a `loops` row per loop and encodes none of
// them (pipeline.record_loops); this route is how a user says "now actually make
// the files", and `worker/loop_cutter.py` claims the row it writes.
//
// SECURITY
// 1. OWNERSHIP, resolved server-side. `getUser()` (not `getSession()`) gives the
//    caller's id, and the job row is checked before anything is written:
//      * a job with `user_id` set may only be requested by that user — 404, not
//        403, so an id probe cannot distinguish "someone else's" from "absent";
//      * a job with `user_id` NULL is an anonymous (pre-sign-in) job. Anyone
//        holding the link may cut it. That is the SAME posture `/jobs/[id]`
//        already has and Jon has already decided to keep (PR #208, finding 2:
//        "anyone with a job's link can open it until the job is deleted").
//        Making this route stricter than the page that links to it would break
//        the free path without closing anything.
// 2. ONE LIVE REQUEST PER JOB, enforced in the DATABASE, not here. Two
//    simultaneous POSTs both reach the INSERT; `loop_requests_live_idx` (UNIQUE
//    on job_id WHERE status IN ('queued','running')) lets exactly one commit and
//    the loser gets 23505, which becomes a 200 naming the live request. A
//    SELECT-then-INSERT check in JS would be a race; this is not.
// 3. EXPIRY. A job past `expires_at` is gone (its R2 objects are swept), so the
//    stems the cut reads no longer exist. Treated as 404, matching GET
//    /api/jobs/:id.

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres unique_violation — the partial index refused a second live request. */
const PG_UNIQUE_VIOLATION = '23505';

function bad(error_code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error_code, message }, { status });
}

interface JobRow {
  user_id: string | null;
  status: string;
}

/**
 * Resolve the job and decide whether this caller may act on it.
 *
 * Returns a DISCRIMINATED result — `{ job }` or `{ denied }` — rather than
 * "the row, or else a NextResponse". The union-plus-instanceof version read
 * fine and was wrong in a way the type checker could not see: `instanceof`
 * needs NextResponse to be a real constructor at runtime, so the check silently
 * becomes a TypeError wherever it is not, every request 500s, and the ownership
 * rule is bypassed on the way to the error handler. A tagged result cannot do
 * that.
 */
type Authorized = { job: JobRow; denied?: undefined };
type Denied = { job?: undefined; denied: NextResponse };

async function authorize(jobId: string): Promise<Authorized | Denied> {
  if (!UUID_RE.test(jobId)) {
    return { denied: bad('NOT_FOUND', 'Job not found', 404) };
  }
  const res = await db.query<JobRow>(
    `SELECT user_id, status FROM jobs WHERE id = $1 AND expires_at > now()`,
    [jobId],
  );
  if (res.rowCount === 0) {
    return { denied: bad('NOT_FOUND', 'Job not found', 404) };
  }
  const job = res.rows[0];
  if (job.user_id !== null) {
    const user = await getUser();
    if (!user || user.user_id !== job.user_id) {
      // 404 rather than 403: a 403 confirms the job exists.
      return { denied: bad('NOT_FOUND', 'Job not found', 404) };
    }
  }
  return { job };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  // CSRF: same-origin browser requests only (src/lib/same-origin.ts). A cut
  // spends worker time, so a foreign page must not be able to trigger one.
  const originRefusal = crossOriginRefusal(request);
  if (originRefusal) return bad(BAD_ORIGIN, originRefusal, 403);
  try {
    const auth = await authorize(params.id);
    if (auth.denied) return auth.denied;
    const job = auth.job;

    // Nothing to cut until the pipeline has recorded the rows. `done` is the only
    // status where `loops` is complete; an earlier status means the description
    // itself is still being written and a cut would see a partial set.
    if (job.status !== 'done') {
      return bad(
        'LOOPS_NOT_READY',
        'This song is still processing. Loops can be cut once it is ready.',
        409,
      );
    }

    const uncut = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM loops WHERE job_id = $1 AND cut_at IS NULL`,
      [params.id],
    );
    if ((uncut.rows[0]?.count ?? 0) === 0) {
      // Already cut (or a job with no loops at all). Idempotent success rather
      // than an error: the caller wanted loops and loops is what they have.
      return NextResponse.json({ status: 'done', loops_pending: 0, request: null });
    }

    const user = await getUser();
    try {
      const ins = await db.query<{ id: string; status: string; created_at: string }>(
        `INSERT INTO loop_requests (job_id, requested_by)
         VALUES ($1, $2)
         RETURNING id, status, created_at`,
        [params.id, user?.user_id ?? null],
      );
      return NextResponse.json(
        {
          status: 'queued',
          loops_pending: uncut.rows[0].count,
          request: ins.rows[0],
        },
        { status: 202 },
      );
    } catch (err) {
      if ((err as { code?: string })?.code !== PG_UNIQUE_VIOLATION) throw err;
      // The partial unique index did its job: a cut is already queued or
      // running for this job. Return the live one rather than a conflict — the
      // caller's intent ("cut my loops") is already satisfied.
      const live = await db.query<{ id: string; status: string; created_at: string }>(
        `SELECT id, status, created_at FROM loop_requests
          WHERE job_id = $1 AND status IN ('queued','running')
          LIMIT 1`,
        [params.id],
      );
      return NextResponse.json({
        status: live.rows[0]?.status ?? 'queued',
        loops_pending: uncut.rows[0].count,
        request: live.rows[0] ?? null,
        already_requested: true,
      });
    }
  } catch (err) {
    Sentry.captureException(err);
    console.error(`POST /api/jobs/${params.id}/loops error:`, err);
    return bad('INTERNAL_ERROR', 'Internal server error', 500);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const auth = await authorize(params.id);
    if (auth.denied) return auth.denied;

    const [counts, live] = await Promise.all([
      db.query<{ total: number; cut: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(cut_at)::int AS cut
           FROM loops WHERE job_id = $1`,
        [params.id],
      ),
      db.query<{ id: string; status: string; loops_cut: number; error_code: string | null }>(
        `SELECT id, status, loops_cut, error_code FROM loop_requests
          WHERE job_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [params.id],
      ),
    ]);

    const total = counts.rows[0]?.total ?? 0;
    const cut = counts.rows[0]?.cut ?? 0;
    return NextResponse.json({
      loops_total: total,
      loops_cut: cut,
      loops_pending: total - cut,
      request: live.rows[0] ?? null,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id}/loops error:`, err);
    return bad('INTERNAL_ERROR', 'Internal server error', 500);
  }
}
