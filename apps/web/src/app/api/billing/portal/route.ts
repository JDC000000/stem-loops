// POST /api/billing/portal
// Create a Stripe Customer Portal session so the user can manage their
// subscription, update payment method, or download past invoices.
// Returns { url } for the client to redirect to.
//
// Auth: required. A user who has not yet made any purchase (and therefore
// has no stripe_customer_id) gets 404 NO_CUSTOMER — portal only exists after
// at least one checkout.

import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getUser } from '@/lib/supabase-server';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error_code: 'UNAUTHENTICATED', message: 'Sign in to manage billing.' },
      { status: 401 },
    );
  }

  const { rows } = await db.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [user.id],
  );
  const customerId = rows[0]?.stripe_customer_id ?? null;
  if (!customerId) {
    return NextResponse.json(
      {
        error_code: 'NO_CUSTOMER',
        message: 'Make a purchase first before opening the billing portal.',
      },
      { status: 404 },
    );
  }

  const origin = req.headers.get('origin') ?? 'https://stem-loops.com';
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/account`,
  });

  return NextResponse.json({ url: session.url });
}
