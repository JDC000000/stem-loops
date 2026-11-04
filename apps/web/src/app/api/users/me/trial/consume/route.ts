// POST /api/users/me/trial/consume — V3 Phase 1a (TSD §1.6, V3-C10).
//
// Decrements the caller's trial grant by one song. The job-create path at
// /api/jobs ALSO calls consumeTrial() from @/lib/trial directly (same
// process, no HTTP round-trip). This route exists so the same contract is
// reachable over HTTP for tests, operations, and any client-side flow that
// needs to decrement the trial counter outside of a job creation.
//
// Round-2 FIX #3: this route is authed-but-publicly-reachable — any signed-in
// user can POST it and burn their own grant to 0 (self-DoS). The earlier
// "INTERNAL" comment was misleading; dropping that label and rate-limiting
// to the same burst ceiling as /api/jobs (3 per 60 s per user) is the
// honest fix. The per-user advisory lock + CHECK (songs_used <= 3) inside
// consumeTrial() still caps real song consumption at 3 regardless.
//
// Response:
//   200 { ok: true,  songs_remaining, expires_at }
//   200 { ok: false, reason: 'no_grant' | 'expired' | 'exhausted' }
//   401 when unauthenticated.
//   429 when the burst limit trips.
//
// Auth: required. Advisory-lock on hashtext('trial_consume:' || user_id)
// is taken inside consumeTrial().

import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { consumeTrial } from '@/lib/trial';
import { checkBurstLimit } from '@/lib/billing/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to use your trial.', code: 'UNAUTHENTICATED' },
      { status: 401, headers: NO_STORE },
    );
  }
  // Round-2 FIX #3: match /api/jobs' burst ceiling so an authed caller
  // cannot hammer this surface to spam advisory-lock traffic or race their
  // own consume against job inserts. Same usage_events('job_start_attempt')
  // kind so the counter is shared with /api/jobs — a mixed spray across
  // both endpoints still hits the cap.
  const burst = await checkBurstLimit(user.user_id);
  if (burst) {
    return new NextResponse(
      JSON.stringify({
        error: 'too many requests',
        code: 'rate_limit_burst',
        retry_after_s: burst.retry_after_s,
      }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': String(burst.retry_after_s),
        },
      },
    );
  }
  try {
    const out = await consumeTrial(user.user_id);
    return NextResponse.json(out, { headers: NO_STORE });
  } catch (err) {
    console.error('[users/me/trial/consume] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Trial is temporarily unavailable.', code: 'TRIAL_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }
}
