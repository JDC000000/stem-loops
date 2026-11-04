// GET /api/auth/me — returns the current user as `AuthenticatedUser` or 401.
//
// Purpose: a tested, stable endpoint that downstream Phase 1a agents
// (account page, billing, entitlements) can build against without needing
// to re-implement `getUser()` themselves. It's also the easiest smoke
// test for the whole auth plumbing — if `/api/auth/me` works end-to-end,
// cookies + middleware + server client + verification are all wired.
//
// Caching: forced dynamic, no cache. The response depends on the request
// cookie and nothing else — serving a stale 200 to a signed-out viewer
// (or vice versa) would be a serious bug.

import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'unauthenticated' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(user, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
