// SERVER ONLY. The set-list SQL (#322; Phase B, B2), shared by app/api/set-lists/**.
//
// OWNERSHIP. The web's DB role is stemloops_app, whose RLS policy admits every row (migration
// 044 is backend-only, like 042). So the `user_id = $owner` predicate in EVERY statement
// here is the ownership boundary, exactly as in /api/library and lib/job-access.ts. The
// owner id always comes from getUser() in the route, never from the request. A list that is
// not the caller's is indistinguishable from one that does not exist (the route answers 404).
//
// A song may be added when it is the caller's own job OR an is_demo job (the demo songs are
// readable by everyone, lib/job-access.ts). Never another user's ordinary job.
//
// ITEMS ARE METADATA (brief D-a). An item keeps a snapshot (title, youtube_url, video_id) and
// its job_id, which the retention sweep turns to NULL (ON DELETE SET NULL). What an item
// plays is decided at READ time:
//   link    the newest live job of the SAME owner and URL (so a re-paste revives it);
//   upload  its own job_id, still owned by the list's owner;
//   demo    its own job_id, only while that row is is_demo.
// live = done and retained (JOB_RETAINED_UNTIL_SQL), or in flight (IN_FLIGHT_STATUSES).
//
// LOCKS. Creating a list takes a per-user advisory lock (the 50-list limit). Every change to
// a list's items locks the list row FOR UPDATE first (the 200-song limit, compact positions,
// and atomic reorder: two concurrent reorders serialise, the second is checked against the
// order the first committed). Positions are 0..n-1; the (set_list_id, position) unique is
// DEFERRABLE INITIALLY DEFERRED, so a reorder rewrites them all and is checked at COMMIT.
import { db } from '@/lib/db';
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';
import { IN_FLIGHT_STATUSES } from '@/lib/admission';
import { listDemoJobs } from '@/lib/demo-songs';
import { demoForJobId } from '@/lib/demo-catalog';
import { youtubeVideoId } from '@/lib/song-thumb';
import {
  DEMO_SET,
  DEMO_SET_ID,
  DEMO_SET_NAME,
  canAddList,
  canAddSong,
  type SetListDetail,
  type SetListItem,
  type SetListItemSource,
  type SetListItemState,
  type SetListSummary,
} from '@/lib/set-lists';

type Client = { query: typeof db.query };

/** Postgres unique_violation, and the constraint it named. */
function uniqueViolation(e: unknown): string | null {
  const x = e as { code?: string; constraint?: string } | null;
  return x?.code === '23505' ? (x.constraint ?? '') : null;
}

const TITLE_MAX = 300;
const clipTitle = (t: string | null | undefined): string | null => {
  const s = (t ?? '').trim();
  return s ? Array.from(s).slice(0, TITLE_MAX).join("") : null;
};

// ─── lists ───────────────────────────────────────────────────────────────────

/**
 * The caller's lists, most recently changed first (the first one is the player's
 * "Add to <last-used list>"). With `jobId`, each row also says whether that song is in it
 * (by job, or for a link song by its URL).
 */
export async function listSetLists(ownerId: string, jobId: string | null): Promise<SetListSummary[]> {
  const res = await db.query<{ id: string; name: string; updated_at: Date | string; song_count: number; has_job: boolean | null }>(
    `SELECT l.id::text AS id, l.name, l.updated_at,
            (SELECT count(*)::int FROM public.set_list_songs s WHERE s.set_list_id = l.id) AS song_count,
            CASE WHEN $2::uuid IS NULL THEN NULL ELSE EXISTS (
              SELECT 1 FROM public.set_list_songs s
               WHERE s.set_list_id = l.id
                 AND (s.job_id = $2::uuid
                      OR (s.source = 'link' AND s.youtube_url = (
                            SELECT j.youtube_url FROM public.jobs j WHERE j.id = $2::uuid AND j.user_id = $1::uuid)))
            ) END AS has_job
       FROM public.set_lists l
      WHERE l.user_id = $1::uuid
      ORDER BY l.updated_at DESC, l.created_at DESC`,
    [ownerId, jobId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    song_count: Number(r.song_count),
    updated_at: new Date(r.updated_at).toISOString(),
    ...(jobId ? { has_job: r.has_job === true } : {}),
  }));
}

export type CreateResult =
  | { ok: true; list: SetListSummary }
  | { ok: false; reason: 'limit' | 'name_taken' };

export async function createSetList(ownerId: string, name: string): Promise<CreateResult> {
  try {
    return await db.tx(async (c: Client) => {
      // Serialise creates per user so two tabs cannot both pass the count at 49.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('set_lists:' || $1::text, 0))`, [ownerId]);
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.set_lists WHERE user_id = $1::uuid`,
        [ownerId],
      );
      if (!canAddList(Number(n.rows[0]?.n ?? 0))) return { ok: false, reason: 'limit' } as const;
      const ins = await c.query<{ id: string; name: string; updated_at: Date | string }>(
        `INSERT INTO public.set_lists (user_id, name) VALUES ($1::uuid, $2)
         RETURNING id::text AS id, name, updated_at`,
        [ownerId, name],
      );
      const r = ins.rows[0];
      return { ok: true, list: { id: r.id, name: r.name, song_count: 0, updated_at: new Date(r.updated_at).toISOString() } } as const;
    });
  } catch (e) {
    if (uniqueViolation(e) === 'set_lists_user_name_key') return { ok: false, reason: 'name_taken' };
    throw e;
  }
}

export type RenameResult = { ok: true } | { ok: false; reason: 'not_found' | 'name_taken' };

export async function renameSetList(ownerId: string, listId: string, name: string): Promise<RenameResult> {
  try {
    const res = await db.query(
      `UPDATE public.set_lists SET name = $3, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [listId, ownerId, name],
    );
    return (res.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch (e) {
    if (uniqueViolation(e) === 'set_lists_user_name_key') return { ok: false, reason: 'name_taken' };
    throw e;
  }
}

/** Deletes the list and (FK cascade) its items. Never a job: items are metadata (AC 3). */
export async function deleteSetList(ownerId: string, listId: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM public.set_lists WHERE id = $1::uuid AND user_id = $2::uuid`, [listId, ownerId]);
  return (res.rowCount ?? 0) > 0;
}

// ─── one list, resolved ──────────────────────────────────────────────────────

type ItemRow = {
  item_id: string;
  position: number;
  source: SetListItemSource;
  title: string | null;
  live_id: string | null;
  live_status: string | null;
};

function stateOf(r: ItemRow): SetListItemState {
  if (r.live_status === 'done') return 'ready';
  if (r.live_status && IN_FLIGHT_STATUSES.includes(r.live_status)) return 'processing';
  // Nothing live: a link can be revived by re-pasting it; an upload or demo cannot.
  return r.source === 'link' ? 'expired' : 'unavailable';
}

export function toItem(r: ItemRow): SetListItem {
  const state = stateOf(r);
  return {
    item_id: r.item_id,
    position: Number(r.position),
    source: r.source,
    title: r.title?.trim() || 'Untitled song',
    state,
    job_id: state === 'ready' || state === 'processing' ? r.live_id : null,
  };
}

/** The caller's list with its items resolved, or null when it is not theirs (-> 404). */
export async function getSetList(ownerId: string, listId: string): Promise<SetListDetail | null> {
  const list = await db.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM public.set_lists WHERE id = $1::uuid AND user_id = $2::uuid`,
    [listId, ownerId],
  );
  if (list.rows.length === 0) return null;
  const items = await db.query<ItemRow>(
    `SELECT s.item_id::text AS item_id, s.position, s.source, s.title,
            r.id AS live_id, r.status AS live_status
       FROM public.set_list_songs s
       LEFT JOIN LATERAL (
         SELECT jobs.id::text AS id, jobs.status
           FROM jobs
          WHERE CASE s.source
                  WHEN 'link'   THEN jobs.user_id = $2::uuid AND jobs.youtube_url = s.youtube_url
                  WHEN 'upload' THEN jobs.id = s.job_id AND jobs.user_id = $2::uuid
                  ELSE               jobs.id = s.job_id AND jobs.is_demo
                END
            AND ((jobs.status = 'done' AND ${JOB_RETAINED_UNTIL_SQL} > now())
                 OR jobs.status = ANY($3::text[]))
          ORDER BY jobs.created_at DESC
          LIMIT 1
       ) r ON true
      WHERE s.set_list_id = $1::uuid
      ORDER BY s.position`,
    [listId, ownerId, IN_FLIGHT_STATUSES],
  );
  return { id: list.rows[0].id, name: list.rows[0].name, is_demo: false, items: items.rows.map(toItem) };
}

/**
 * The code-defined Demo set (brief D-c): #322's three songs in order, resolved only among
 * is_demo rows (listDemoJobs reads `is_demo = true` only, done and retained). A song that is
 * gone is an "unavailable" row; the set itself never disappears and never errors for that.
 */
export async function getDemoSet(): Promise<SetListDetail> {
  const demos = await listDemoJobs();
  const items: SetListItem[] = DEMO_SET.map((song, position) => {
    const job = demos.find((d) => d.slug === song.slug) ?? null;
    return {
      item_id: song.slug,
      position,
      source: 'demo',
      title: song.title,
      state: job ? 'ready' : 'unavailable',
      job_id: job ? job.id : null,
    };
  });
  return { id: DEMO_SET_ID, name: DEMO_SET_NAME, is_demo: true, items };
}

// ─── items ───────────────────────────────────────────────────────────────────

/** Lock the caller's list row, or null when it is not theirs. */
async function lockOwnedList(c: Client, ownerId: string, listId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM public.set_lists WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [listId, ownerId]);
  return r.rows.length > 0;
}

export type AddResult =
  | { ok: true; added: boolean; item_id: string }
  | { ok: false; reason: 'not_found' | 'job_not_found' | 'limit' };

export async function addSongToSetList(ownerId: string, listId: string, jobId: string): Promise<AddResult> {
  return db.tx(async (c: Client) => {
    if (!(await lockOwnedList(c, ownerId, listId))) return { ok: false, reason: 'not_found' } as const;
    // The caller's own job, or a demo song. Never another user's ordinary job (AC 2).
    const job = await c.query<{ id: string; is_demo: boolean; youtube_url: string | null; video_id: string | null; title: string | null; original_filename: string | null }>(
      `SELECT jobs.id::text AS id, jobs.is_demo, jobs.youtube_url, jobs.video_id, jobs.title, jobs.original_filename
         FROM jobs
        WHERE jobs.id = $1::uuid
          AND (jobs.user_id = $2::uuid OR jobs.is_demo = true)
          AND ${JOB_RETAINED_UNTIL_SQL} > now()`,
      [jobId, ownerId],
    );
    const j = job.rows[0];
    if (!j) return { ok: false, reason: 'job_not_found' } as const;
    const source: SetListItemSource = j.is_demo === true ? 'demo' : j.youtube_url ? 'link' : 'upload';
    const url = source === 'link' ? j.youtube_url : null;
    const existing = await c.query<{ item_id: string }>(
      `SELECT item_id::text AS item_id FROM public.set_list_songs
        WHERE set_list_id = $1::uuid AND (job_id = $2::uuid OR ($3::text IS NOT NULL AND youtube_url = $3::text))`,
      [listId, jobId, url],
    );
    if (existing.rows[0]) return { ok: true, added: false, item_id: existing.rows[0].item_id } as const;
    const n = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.set_list_songs WHERE set_list_id = $1::uuid`,
      [listId],
    );
    const count = Number(n.rows[0]?.n ?? 0);
    if (!canAddSong(count)) return { ok: false, reason: 'limit' } as const;
    const title =
      clipTitle(source === 'demo' ? (demoForJobId(j.id)?.title ?? j.title) : j.title) ?? clipTitle(j.original_filename);
    const videoId = (j.video_id && /^[A-Za-z0-9_-]{11}$/.test(j.video_id) ? j.video_id : null) ?? youtubeVideoId(url);
    const ins = await c.query<{ item_id: string }>(
      `INSERT INTO public.set_list_songs (set_list_id, job_id, source, youtube_url, video_id, title, position)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       RETURNING item_id::text AS item_id`,
      [listId, jobId, source, url, videoId, title, count],
    );
    await c.query(`UPDATE public.set_lists SET updated_at = now() WHERE id = $1::uuid`, [listId]);
    return { ok: true, added: true, item_id: ins.rows[0].item_id } as const;
  });
}

export type RemoveResult = { ok: true; removed: boolean } | { ok: false; reason: 'not_found' };

/** Remove one item (by item id, or by the job it plays) and close the gap in positions. */
export async function removeSongFromSetList(
  ownerId: string,
  listId: string,
  by: { itemId: string } | { jobId: string },
): Promise<RemoveResult> {
  return db.tx(async (c: Client) => {
    if (!(await lockOwnedList(c, ownerId, listId))) return { ok: false, reason: 'not_found' } as const;
    const del =
      'itemId' in by
        ? await c.query<{ position: number }>(
            `DELETE FROM public.set_list_songs WHERE set_list_id = $1::uuid AND item_id = $2::uuid RETURNING position`,
            [listId, by.itemId],
          )
        : await c.query<{ position: number }>(
            `DELETE FROM public.set_list_songs
              WHERE set_list_id = $1::uuid
                AND (job_id = $2::uuid
                     OR (source = 'link' AND youtube_url = (
                           SELECT j.youtube_url FROM public.jobs j WHERE j.id = $2::uuid AND j.user_id = $3::uuid)))
              RETURNING position`,
            [listId, by.jobId, ownerId],
          );
    if (del.rows.length === 0) return { ok: true, removed: false } as const;
    // Renumber 0..n-1 in the current order (deferred unique: checked at COMMIT).
    await c.query(
      `UPDATE public.set_list_songs s SET position = o.rn - 1
         FROM (SELECT item_id, row_number() OVER (ORDER BY position) AS rn
                 FROM public.set_list_songs WHERE set_list_id = $1::uuid) o
        WHERE s.item_id = o.item_id AND s.position <> o.rn - 1`,
      [listId],
    );
    await c.query(`UPDATE public.set_lists SET updated_at = now() WHERE id = $1::uuid`, [listId]);
    return { ok: true, removed: true } as const;
  });
}

export type ReorderResult = { ok: true } | { ok: false; reason: 'not_found' | 'stale' };

/**
 * Put the list in exactly `order` (every item id, once). Atomic (AC 4): one transaction,
 * the list row locked, every position rewritten, the deferred unique checked at COMMIT. An
 * order that is not a permutation of the items as they are NOW (a concurrent add, remove or
 * reorder changed them) is refused as stale, so a lost update is impossible.
 */
export async function reorderSetList(ownerId: string, listId: string, order: string[]): Promise<ReorderResult> {
  return db.tx(async (c: Client) => {
    if (!(await lockOwnedList(c, ownerId, listId))) return { ok: false, reason: 'not_found' } as const;
    const cur = await c.query<{ item_id: string }>(
      `SELECT item_id::text AS item_id FROM public.set_list_songs WHERE set_list_id = $1::uuid`,
      [listId],
    );
    const want = order.map((s) => s.toLowerCase());
    const have = new Set(cur.rows.map((r) => r.item_id.toLowerCase()));
    if (want.length !== have.size || new Set(want).size !== want.length || !want.every((id) => have.has(id))) {
      return { ok: false, reason: 'stale' } as const;
    }
    await c.query(
      `UPDATE public.set_list_songs s SET position = o.ord - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(item_id, ord)
        WHERE s.set_list_id = $1::uuid AND s.item_id = o.item_id`,
      [listId, want],
    );
    await c.query(`UPDATE public.set_lists SET updated_at = now() WHERE id = $1::uuid`, [listId]);
    return { ok: true } as const;
  });
}
