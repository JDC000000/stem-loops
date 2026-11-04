// GET /api/billing/credits/balance — V3 Phase 1a (TSD §1.9).
//
// Returns the signed-in user's credit balance plus the two underlying
// ledgers for UI display:
//   {
//     credits_remaining: number,
//     purchases: Purchase[],
//     recent_consumption: Consumption[],
//   }
//
// credits_remaining is read from v_credit_balance (security_invoker view
// that enforces per-user RLS; see migration 013). The two detail arrays
// are the last 50 rows of each ledger, in reverse-chronological order,
// for a compact account-page view.
//
// Caching: forced no-store — the response is user-specific AND changes
// as the webhook writes new purchases.

import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type Purchase = {
  id: string;
  pack_code: 'credits_20' | 'credits_60' | 'credits_180';
  credits_granted: number;
  amount_cad_cents: number;
  promo_code: string | null;
  created_at: string;
};

export type Consumption = {
  id: string;
  job_id: string;
  consumed_at: string;
};

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to view credits.', code: 'UNAUTHENTICATED' },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const [balRes, purRes, conRes] = await Promise.all([
      db.query<{ credits_remaining: number | string | null }>(
        `SELECT credits_remaining FROM v_credit_balance WHERE user_id = $1`,
        [user.user_id],
      ),
      db.query<Purchase>(
        `SELECT id, pack_code, credits_granted, amount_cad_cents, promo_code, created_at
           FROM credit_purchases
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [user.user_id],
      ),
      db.query<Consumption>(
        `SELECT id, job_id, consumed_at
           FROM credit_consumption
          WHERE user_id = $1
          ORDER BY consumed_at DESC
          LIMIT 50`,
        [user.user_id],
      ),
    ]);

    const raw = balRes.rows[0]?.credits_remaining;
    // Defensive clamp (review M6): never surface a negative balance even if
    // migration 022's GREATEST(0, ...) has not been applied yet.
    const credits_remaining = Math.max(
      0,
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseInt(raw, 10) || 0
          : 0,
    );

    return NextResponse.json(
      {
        credits_remaining,
        purchases: purRes.rows,
        recent_consumption: conRes.rows,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error('[billing/credits/balance] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Credit balance is temporarily unavailable.', code: 'ENTITLEMENT_UNAVAILABLE' },
      { status: 503, headers: NO_STORE },
    );
  }
}
