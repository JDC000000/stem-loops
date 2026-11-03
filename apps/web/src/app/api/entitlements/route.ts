// GET /api/entitlements
// Return what the signed-in user can currently do.
// Shape:
//   {
//     entitlements: [{ capability, granted_via, expires_at }, ...],
//     credits: { credits_granted, credits_consumed, balance },
//     subscription: { sku, status, current_period_end } | null
//   }
//
// Auth: required. Unauthenticated → 401 UNAUTHENTICATED.
//
// Reads v_credit_balance (view, security_invoker=true so user-scoped),
// entitlements (filtered to active rows), and the most recent active
// subscriptions row.

import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase-server';
import { db } from '@/lib/db';

type EntitlementRow = {
  capability: string;
  granted_via: string;
  expires_at: string | null;
};

type BalanceRow = {
  credits_granted: number;
  credits_consumed: number;
  balance: number;
};

type SubscriptionRow = {
  sku: string;
  status: string;
  current_period_end: string | null;
};

export async function GET() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error_code: 'UNAUTHENTICATED', message: 'Sign in to view entitlements.' },
      { status: 401 },
    );
  }

  const [ents, bal, sub] = await Promise.all([
    db.query<EntitlementRow>(
      `SELECT capability, granted_via, expires_at
         FROM entitlements
        WHERE user_id = $1
          AND (expires_at IS NULL OR expires_at > now())`,
      [user.id],
    ),
    db.query<BalanceRow>(
      `SELECT credits_granted, credits_consumed, balance
         FROM v_credit_balance
        WHERE user_id = $1`,
      [user.id],
    ),
    db.query<SubscriptionRow>(
      `SELECT sku, status, current_period_end
         FROM subscriptions
        WHERE user_id = $1 AND status IN ('trialing','active','past_due')
        ORDER BY updated_at DESC
        LIMIT 1`,
      [user.id],
    ),
  ]);

  return NextResponse.json({
    entitlements: ents.rows,
    credits:
      bal.rows[0] ?? { credits_granted: 0, credits_consumed: 0, balance: 0 },
    subscription: sub.rows[0] ?? null,
  });
}
