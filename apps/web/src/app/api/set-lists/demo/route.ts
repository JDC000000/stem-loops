// GET /api/set-lists/demo — the code-defined "Demo set" (#322; brief D-c).
//
// Shape: { list: { id: 'demo', name: 'Demo set', is_demo: true, items: [...] } } — the three
// demo songs in #322's order (I'm Asking You, Offline, Lucky Ticket), each resolved ONLY
// among is_demo rows (lib/demo-songs.ts). A song that is gone is an "unavailable" row; the set
// never disappears (it has no database row a sweep or an account deletion could remove).
//
// Signed out works (demos open without sign-in, #305). Gated, like every other demo read, by
// the per-IP demo read limit (lib/demo-rate.ts; 429 with DEMO_RATE_LIMIT_MSG). Read-only:
// this module exports GET ONLY, so Next answers POST / PATCH / PUT / DELETE with 405 and no
// write path exists (test/set-lists-routes.test.mjs pins the export list). It writes nothing.
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { DEMO_RATE_LIMIT_MSG, demoReadAllowed } from '@/lib/demo-rate';
import { getDemoSet } from '@/lib/set-lists-server';
import type { SetListDetail } from '@/lib/set-lists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-IP limited, so never served from a shared cache (that would bypass the limit).
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type DemoSetResponse = { list: SetListDetail };

export async function GET(request: NextRequest) {
  try {
    if (!(await demoReadAllowed(request))) {
      return NextResponse.json({ error_code: 'RATE_LIMITED', message: DEMO_RATE_LIMIT_MSG }, { status: 429, headers: NO_STORE });
    }
    const body: DemoSetResponse = { list: await getDemoSet() };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/set-lists/demo error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json(
      { error_code: 'INTERNAL_ERROR', message: 'The Demo set is temporarily unavailable.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
