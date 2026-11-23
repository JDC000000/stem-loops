// GET /api/library — the signed-in user's songs, from the database.
//
// Jon, 2026-11-15: "Pro and Studio = kept WHILE SUBSCRIBED, plus 30 days' grace after the
// subscription ends. Users build a LIBRARY of songs." The anonymous history (lib/history.ts)
// is a per-browser localStorage list of the last 20 ids that drops anything older than 24 h,
// so it cannot be a library: it forgets songs a subscriber still owns, and it is empty on a
// second device. This route is the library's source of truth.
//
// Phase B, B1 (migration 043; US 1.8, 5.2-5.4): the library also keeps every song AFTER its
// audio is gone. Two lists:
//   * `songs`   — jobs that still exist (retained by JOB_RETAINED_UNTIL_SQL), as before. Each
//                 row's `expires_at` IS that deadline. /loops reads this list only.
//   * `entries` — `library_entries` rows the retention sweep left behind (state 'expired'):
//                 link or file name, title, video id, BPM, key; no job id (D-a). A link entry
//                 is LEFT OUT while the same user has a live job of the same URL (done and
//                 retained, or in flight): that job is in `songs`, so a re-made song is listed
//                 once (AC 7). A database without 043 (42P01) has no entries.
//
// SECURITY
//   * Owner-scoped SERVER-SIDE: the user id comes from getUser() (the verified session), never
//     from the request, and every query filters `user_id = $1` on it. There is no parameter a
//     caller can set to read someone else's list. The web's DB role is stemloops_app, whose RLS
//     policy admits every row, so this WHERE is the ownership boundary (the same posture as
//     lib/job-access.ts and the job routes).
//   * Signed out -> 401 with an empty list; the page then shows the anonymous history.
//   * Columns are an allow-list: no ip hash, fingerprint, url-to-R2 key, or cost.
//   * private, no-store: the body is per-user.

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';
import { IN_FLIGHT_STATUSES } from '@/lib/admission';
import { isUnmigrated, liveJobPredicate } from '@/lib/library-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** Hard cap on one response. A subscriber at Studio's 150 songs/month for a year is ~1800;
 *  the page lists the newest LIBRARY_LIMIT and says so when there are more. Per list. */
const LIBRARY_LIMIT = 500;

export type LibrarySong = {
  id: string;
  title: string | null;
  original_filename: string | null;
  youtube_url: string | null;
  video_id: string | null;
  bpm: number | null;
  musical_key: string | null;
  status: string;
  created_at: string;
  /** When this song will be deleted (JOB_RETAINED_UNTIL_SQL). */
  expires_at: string;
  /** A demo song (migration 040): kept until DEMO_RETAINED_UNTIL; the page hides "deleted in". */
  is_demo: boolean;
};

/** A song whose audio is gone (migration 043). `entry_id` is what Re-make and Remove take. */
export type LibraryEntry = {
  entry_id: string;
  state: 'expired';
  input_kind: 'youtube' | 'upload';
  youtube_url: string | null;
  original_filename: string | null;
  title: string | null;
  video_id: string | null;
  bpm: number | null;
  musical_key: string | null;
  /** When the song was first made. */
  created_at: string;
};

export type LibraryResponse = { songs: LibrarySong[]; entries: LibraryEntry[]; truncated: boolean };

export async function GET() {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.json(
        { error_code: 'AUTH_REQUIRED', message: 'Sign in to see your library.', songs: [], entries: [] },
        { status: 401, headers: NO_STORE },
      );
    }
    const res = await db.query<LibrarySong>(
      `SELECT id::text AS id, title, original_filename, youtube_url, video_id, bpm, musical_key, status, created_at,
              is_demo, ${JOB_RETAINED_UNTIL_SQL} AS expires_at
         FROM jobs
        WHERE user_id = $1::uuid AND ${JOB_RETAINED_UNTIL_SQL} > now()
        ORDER BY created_at DESC
        LIMIT $2`,
      [user.user_id, LIBRARY_LIMIT + 1],
    );
    let entries: LibraryEntry[] = [];
    try {
      const er = await db.query<LibraryEntry>(
        `SELECT e.id::text AS entry_id, 'expired' AS state, e.input_kind, e.youtube_url, e.original_filename,
                e.title, e.video_id, e.bpm, e.musical_key, e.first_created_at AS created_at
           FROM library_entries e
          WHERE e.user_id = $1::uuid
            AND NOT (e.youtube_url IS NOT NULL AND EXISTS (
                  SELECT 1 FROM jobs
                   WHERE jobs.user_id = $1::uuid AND jobs.youtube_url = e.youtube_url
                     AND ${liveJobPredicate('$3')}))
          ORDER BY e.first_created_at DESC
          LIMIT $2`,
        [user.user_id, LIBRARY_LIMIT + 1, IN_FLIGHT_STATUSES],
      );
      entries = er.rows;
    } catch (err) {
      if (!isUnmigrated(err)) throw err;
    }
    const truncated = res.rows.length > LIBRARY_LIMIT || entries.length > LIBRARY_LIMIT;
    const body: LibraryResponse = {
      songs: res.rows.slice(0, LIBRARY_LIMIT),
      entries: entries.slice(0, LIBRARY_LIMIT),
      truncated,
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/library error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json(
      { error_code: 'INTERNAL_ERROR', message: 'Your library is temporarily unavailable.', songs: [], entries: [] },
      { status: 500, headers: NO_STORE },
    );
  }
}
