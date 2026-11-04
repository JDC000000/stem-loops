// GET /api/entitlements — V3 Phase 1a (TSD §1.7).
//
// Returns the feature envelope the caller uses for gating UI:
//   {
//     plan_code,
//     period_start, period_end,
//     jobs_used, jobs_quota,
//     services: string[],
//     export: { stems, wav24 },
//     credits_remaining,
//     trial_songs_remaining,
//   }
//
// Auth: optional. Unauthenticated requests get the anonymous free-tier
// envelope (services from the 'free' plan, zero exports, trial state keyed
// by IP hash is NOT computed here — the free-tier daily quota lives in the
// admission path, not entitlements).
//
// Caching: forced no-store on the response, but the underlying snapshot
// goes through the 30-second in-memory cache (TSD §1.7).

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import {
  getEntitlementSnapshot,
  EntitlementError,
  type EntitlementSnapshot,
} from '@/lib/billing/entitlements';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

async function anonymousEnvelope(): Promise<EntitlementSnapshot> {
  // Read the free-plan row so the anonymous envelope reflects whatever
  // the DB currently says Free gets (do NOT hard-code the shape here).
  const res = await db.query<{
    code: string;
    monthly_job_quota: number;
    services: string[];
    export_stems: boolean;
    export_wav24: boolean;
  }>(
    `SELECT code, monthly_job_quota, services, export_stems, export_wav24
       FROM plans WHERE code = 'free'`,
  );
  const plan = res.rows[0];
  if (!plan) {
    // Migration 013 self-seeds 'free'; if it's absent something is very
    // wrong. Degrade gracefully with a zero envelope.
    return {
      plan_code: 'free',
      period_start: null,
      period_end: null,
      jobs_used: 0,
      jobs_quota: 0,
      services: [],
      export: { stems: false, wav24: false },
      credits_remaining: 0,
      trial_songs_remaining: null,
    };
  }
  return {
    plan_code: plan.code,
    period_start: null,
    period_end: null,
    jobs_used: 0,
    jobs_quota: plan.monthly_job_quota,
    services: plan.services ?? [],
    export: { stems: plan.export_stems, wav24: plan.export_wav24 },
    credits_remaining: 0,
    trial_songs_remaining: null,
  };
}

export async function GET(_req: NextRequest) {
  const user = await getUser();
  try {
    const snapshot = user
      ? await getEntitlementSnapshot(user.user_id)
      : await anonymousEnvelope();
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof EntitlementError) {
      return NextResponse.json(
        { error: err.message, code: err.errorCopyKey },
        { status: err.status, headers: NO_STORE },
      );
    }
    console.error('[entitlements] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Entitlements unavailable.', code: 'ENTITLEMENT_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }
}
