// DELETE /api/library/:entryId — "Remove" an expired song from the library (Phase B, B1; PB-1:
// Free keeps a song's link, title, BPM and key until Remove or account deletion).
//
// Deletes ONE library_entries row of the caller's (migration 043). Live songs are jobs and are
// not removed here. SECURITY: same-origin guard first; owner-scoped from getUser(); an entry
// that is not the caller's (or does not exist, or 043 is not applied) is 404, never 403, so the
// answer never confirms that someone else's id is real.
//
// Errors: 401 AUTH_REQUIRED · 403 BAD_ORIGIN · 404 NOT_FOUND · 500 INTERNAL_ERROR
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { removeOwnedEntry } from '@/lib/library-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: { entryId: string } };

const fail = (status: number, error_code: string, message: string) =>
  NextResponse.json({ error_code, message }, { status, headers: NO_STORE });

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const refusal = crossOriginRefusal(req);
  if (refusal) return fail(403, BAD_ORIGIN, refusal);
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to change your library.');
    const id = params?.entryId;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(404, 'NOT_FOUND', 'That song is not in your library.');
    if (!(await removeOwnedEntry(db, user.user_id, id))) return fail(404, 'NOT_FOUND', 'That song is not in your library.');
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('DELETE /api/library/:entryId error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not remove that song. Please try again.');
  }
}
