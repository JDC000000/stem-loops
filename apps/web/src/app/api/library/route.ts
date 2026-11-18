// GET /api/library — the signed-in user's songs, from the database.
//
// Jon, 2026-11-15: "Pro and Studio = kept WHILE SUBSCRIBED, plus 30 days' grace after the
// subscription ends. Users build a LIBRARY of songs." The anonymous history (lib/history.ts)
// is a per-browser localStorage list of the last 20 ids that drops anything older than 24 h,
// so it cannot be a library: it forgets songs a subscriber still owns, and it is empty on a
// second device. This route is the library's source of truth.
//
// SECURITY
//   * Owner-scoped SERVER-SIDE: the user id comes from getUser() (the verified session), never
//     from the request, and the query filters `user_id = $1` on it. There is no parameter a
//     caller can set to read someone else's list. The web's DB role is stemloops_app, whose RLS
//     policy admits every row, so this WHERE is the ownership boundary (the same posture as
//     lib/job-access.ts and the job routes).
//   * Signed out -> 401 with an empty list; the page then shows the anonymous history.
//   * Only songs that still exist: `${JOB_RETAINED_UNTIL_SQL} > now()`, the same rule the
//     job routes serve on and the worker's sweep deletes on (lib/retention.ts). Each row's
//     `expires_at` IS that deadline, so the page shows when it will really be deleted.
//   * Columns are an allow-list: no ip hash, fingerprint, url-to-R2 key, or cost.
//   * private, no-store: the body is per-user.

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** Hard cap on one response. A subscriber at Studio's 150 songs/month for a year is ~1800;
 *  the page lists the newest LIBRARY_LIMIT and says so when there are more. */
const LIBRARY_LIMIT = 500;

export type LibrarySong = {
  id: string;
  title: string | null;
  original_filename: string | null;
  youtube_url: string | null;
  status: string;
  created_at: string;
  /** When this song will be deleted (JOB_RETAINED_UNTIL_SQL). */
  expires_at: string;
  /** A demo song (migration 040): kept until DEMO_RETAINED_UNTIL; the page hides "deleted in". */
  is_demo: boolean;
};

export async function GET() {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.json(
        { error_code: 'AUTH_REQUIRED', message: 'Sign in to see your library.', songs: [] },
        { status: 401, headers: NO_STORE },
      );
    }
    const res = await db.query<LibrarySong>(
      `SELECT id::text AS id, title, original_filename, youtube_url, status, created_at,
              is_demo, ${JOB_RETAINED_UNTIL_SQL} AS expires_at
         FROM jobs
        WHERE user_id = $1::uuid AND ${JOB_RETAINED_UNTIL_SQL} > now()
        ORDER BY created_at DESC
        LIMIT $2`,
      [user.user_id, LIBRARY_LIMIT + 1],
    );
    const truncated = res.rows.length > LIBRARY_LIMIT;
    return NextResponse.json(
      { songs: res.rows.slice(0, LIBRARY_LIMIT), truncated },
      { headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/library error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json(
      { error_code: 'INTERNAL_ERROR', message: 'Your library is temporarily unavailable.', songs: [] },
      { status: 500, headers: NO_STORE },
    );
  }
}
