// Server-side SQL for the song library (Phase B, B1; migration 043). Shared by GET /api/library,
// POST /api/library/remake and DELETE /api/library/:entryId.
//
// D-a (brief): an expired song is a METADATA row keyed by source, `library_entries`, with no
// job_id. A link entry resolves by URL to the newest LIVE job of the same user and URL, where
// live = done and retained (JOB_RETAINED_UNTIL_SQL > now(), the rule the job routes serve on
// and the worker's sweep deletes on), or in flight (IN_FLIGHT_STATUSES, lib/admission.ts).
//
// OWNERSHIP: every statement here filters on the caller's user id, which the routes take from
// getUser() and pass as a bound parameter. The web's role (stemloops_app) has an admit-all RLS
// policy on library_entries (migration 043), so these WHEREs are the ownership boundary.
//
// NOT MIGRATED YET: a database without 043 answers 42P01 (undefined_table). The list then has
// no entries and an entry lookup finds nothing (the routes answer 404), exactly like before.
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';
import { IN_FLIGHT_STATUSES } from '@/lib/admission';

/** True for "relation does not exist": migration 043 not applied yet. */
export const isUnmigrated = (err: unknown): boolean => (err as { code?: string } | null)?.code === '42P01';

/**
 * `jobs` row is live: done and retained, or in flight. `statusesParam` is the placeholder that
 * carries IN_FLIGHT_STATUSES (e.g. '$3'). JOB_RETAINED_UNTIL_SQL names `jobs.` columns, so the
 * table must be referenced as `jobs` (no alias) where this is used.
 */
export function liveJobPredicate(statusesParam: string): string {
  return `((jobs.status = 'done' AND ${JOB_RETAINED_UNTIL_SQL} > now()) OR jobs.status = ANY(${statusesParam}::text[]))`;
}

/** The newest live job of this user for this URL: SELECT id; params [userId, url, IN_FLIGHT_STATUSES]. */
export const LIVE_JOB_BY_URL_SQL = `SELECT jobs.id::text AS id FROM jobs
  WHERE jobs.user_id = $1::uuid AND jobs.youtube_url = $2 AND ${liveJobPredicate('$3')}
  ORDER BY jobs.created_at DESC LIMIT 1`;

export const liveJobParams = (userId: string, url: string) => [userId, url, IN_FLIGHT_STATUSES];

/** One of the caller's entries (Re-make reads this before anything else). */
export type OwnedEntry = { id: string; youtube_url: string | null; input_kind: string; title: string | null };

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> };

export async function getOwnedEntry(db: Queryable, userId: string, entryId: string): Promise<OwnedEntry | null> {
  try {
    const r = await db.query(
      `SELECT id::text AS id, youtube_url, input_kind, title FROM library_entries
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [entryId, userId],
    );
    return (r.rows[0] as OwnedEntry | undefined) ?? null;
  } catch (err) {
    if (isUnmigrated(err)) return null;
    throw err;
  }
}

/** Remove: delete one of the caller's entries. false when it is not theirs (or not there). */
export async function removeOwnedEntry(db: Queryable, userId: string, entryId: string): Promise<boolean> {
  try {
    const r = await db.query(`DELETE FROM library_entries WHERE id = $1::uuid AND user_id = $2::uuid`, [entryId, userId]);
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    if (isUnmigrated(err)) return false;
    throw err;
  }
}

/** Thrown by Re-make's beforeInsert when the entry was removed while the request was in flight. */
export class EntryGone extends Error {
  constructor() {
    super('library entry no longer exists');
  }
}

/**
 * Re-make's hooks for createAuthedLinkJob (B0, D-e). NEITHER writes the entry.
 *   findExisting: read-only, lock-free; the newest live job of this user + URL, or null.
 *   beforeInsert: inside the insert tx, immediately before the INSERT: lock the caller's
 *     entry row (FOR UPDATE) so two Re-makes of one entry serialise here, then repeat the
 *     live-job lookup. The loser of a race waits for the winner's COMMIT, sees its job, and
 *     the tx rolls back with nothing spent (200 with that id). An entry that vanished (Removed
 *     meanwhile) throws EntryGone: the tx rolls back and the route answers 404.
 */
export function remakeHooks(entryId: string, userId: string) {
  return {
    findExisting: async (db: Queryable, ctx: { userId: string; canonicalUrl: string }): Promise<string | null> => {
      const r = await db.query(LIVE_JOB_BY_URL_SQL, liveJobParams(ctx.userId, ctx.canonicalUrl));
      return (r.rows[0] as { id: string } | undefined)?.id ?? null;
    },
    beforeInsert: async (client: Queryable, ctx: { userId: string; canonicalUrl: string }): Promise<string | null> => {
      const lock = await client.query(
        `SELECT id FROM library_entries WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
        [entryId, userId],
      );
      if (!lock.rows.length) throw new EntryGone();
      const r = await client.query(LIVE_JOB_BY_URL_SQL, liveJobParams(ctx.userId, ctx.canonicalUrl));
      return (r.rows[0] as { id: string } | undefined)?.id ?? null;
    },
  };
}
