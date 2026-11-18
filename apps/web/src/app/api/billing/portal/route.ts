// POST /api/billing/portal — V3 Phase 1a (TSD §1.1).
//
// Creates a provider-hosted customer portal session (Stripe: Customer
// Portal; Paddle: equivalent) so the signed-in user can update their
// payment method, cancel/upgrade, and download invoices.
//
// Auth: required. Returns { portal_url } for the client to redirect to.
// If the user has never checked out (no customers_billing row for the
// current provider) the response is 404 NO_CUSTOMER — portal only exists
// after at least one checkout attempt.

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';
import { getBillingProvider } from '@/lib/billing';
import { db } from '@/lib/db';
import { appOrigin } from '@/lib/app-url';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // CSRF (QA track B, B-06): same-origin browser requests only, before auth.
  const originRefusal = crossOriginRefusal(req);
  if (originRefusal) {
    return NextResponse.json({ error: originRefusal, code: BAD_ORIGIN }, { status: 403 });
  }
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to manage billing.', code: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  const provider = getBillingProvider();
  const res = await db.query<{ provider_customer_id: string }>(
    `SELECT provider_customer_id
       FROM customers_billing
      WHERE user_id = $1 AND provider = $2`,
    [user.user_id, provider.name],
  );
  const customerId = res.rows[0]?.provider_customer_id ?? null;
  if (!customerId) {
    return NextResponse.json(
      {
        error: 'Make a purchase first before opening the billing portal.',
        code: 'NO_CUSTOMER',
      },
      { status: 404 },
    );
  }

  // QA track B, B-07: the return URL comes from config (lib/app-url.ts), never the Origin header.
  const origin = appOrigin();
  try {
    const session = await provider.createPortalSession(customerId, `${origin}/account`);
    return NextResponse.json({ portal_url: session.url });
  } catch (err) {
    console.error('[billing/portal] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'We could not open the billing portal.', code: 'CHECKOUT_FAILED' },
      { status: 502 },
    );
  }
}
