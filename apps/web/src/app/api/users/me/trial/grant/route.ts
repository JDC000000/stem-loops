// POST /api/users/me/trial/grant — V3 Phase 1a (TSD §1.6, V3-C10).
//
// Grants the signed-in user a 3-song free trial (no card required). The
// trial row lives in public.trial_grants (PK=user_id) and is created by
// grantTrial(). Re-calling this route is idempotent: the PK collision
// means a second call reads the existing row instead of inserting again.
//
// Response: 200 { granted, songs_remaining, expires_at }
//   granted=true  — this call inserted the row.
//   granted=false — a prior row already existed (re-read, no state change).
// 401 when the caller isn't signed in.
// 503 { error, code } on DB failure.
//
// Auth: required via @/lib/auth/supabase getUser(). Unauth -> 401.
// Rate limit: the PK on trial_grants(user_id) already enforces "one grant
// per user ever"; no additional usage_events gate is needed.

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { grantTrial } from '@/lib/trial';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(req: NextRequest) {
  // CSRF (QA track B, B-06): same-origin browser requests only, before auth.
  const originRefusal = crossOriginRefusal(req);
  if (originRefusal) {
    return NextResponse.json({ error: originRefusal, code: BAD_ORIGIN }, { status: 403, headers: NO_STORE });
  }
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to start your trial.', code: 'UNAUTHENTICATED' },
      { status: 401, headers: NO_STORE },
    );
  }
  try {
    const result = await grantTrial(user.user_id);
    return NextResponse.json(
      {
        granted: result.granted,
        songs_remaining: result.songs_remaining,
        expires_at: result.expires_at,
        expired: result.expired,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error('[users/me/trial/grant] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Trial is temporarily unavailable.', code: 'TRIAL_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }
}
