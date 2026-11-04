// POST /api/users/me/trial/consume — V3 Phase 1a (TSD §1.6, V3-C10).
//
// INTERNAL: the job-create path at /api/jobs calls consumeTrial() from
// @/lib/trial directly (same process, no HTTP round-trip). This route
// exists so the same contract is reachable over HTTP for tests,
// operations, and any future client-side flow that needs to decrement
// the trial counter outside of a job creation.
//
// Response:
//   200 { ok: true,  songs_remaining, expires_at }
//   200 { ok: false, reason: 'no_grant' | 'expired' | 'exhausted' }
//   401 when unauthenticated.
//
// Auth: required. Advisory-lock on hashtext('trial_consume:' || user_id)
// is taken inside consumeTrial().

import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { consumeTrial } from '@/lib/trial';

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
