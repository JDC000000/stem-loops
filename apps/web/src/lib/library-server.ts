// Server-side SQL for the song library (Phase B, B1; migration 043). Shared by GET /api/library,
// POST /api/library/remake and DELETE /api/library/:entryId; POST /api/jobs uses pasteHooks (#372).
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
import { LINK_DEFAULT_STEMS } from '@/lib/jobs/create-link-job';
import { hasPlayableStems } from '@/lib/jobs/stem-artifacts';

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

/**
 * A stem selection as a set: distinct, sorted. Empty (or absent) means the default, all six
 * (LINK_DEFAULT_STEMS), which is what a job created without `stems` is given.
 */
export function normaliseStems(stems: readonly string[] | null | undefined): string[] {
  const src = stems && stems.length ? stems : LINK_DEFAULT_STEMS;
  return Array.from(new Set(src)).sort();
}

/**
 * #372 R2 (paste only): the newest live job of this user for this URL whose loops are the ones
 * this request asks for — the SAME stem set (order, duplicates and "default = all six" ignored;
 * a stored '{}' counts as all six) and the SAME loop length. A different selection is a
 * different product (the worker cuts loops only for requested_stems), so it is a new job.
 * Params [userId, url, IN_FLIGHT_STATUSES, normalisedStems, loopLengthBars, defaultStems,
 * skippedIds]. QW-2: `skippedIds` are DONE jobs already found unplayable (see pasteHooks); the
 * row carries `status` so the caller knows whether a hit is done (probe it) or in flight (reuse).
 */
export const LIVE_JOB_BY_URL_AND_SELECTION_SQL = `SELECT jobs.id::text AS id, jobs.status FROM jobs
  WHERE jobs.user_id = $1::uuid AND jobs.youtube_url = $2 AND ${liveJobPredicate('$3')}
    AND NOT (jobs.id = ANY($7::uuid[]))
    AND jobs.loop_length_bars = $5::int
    AND ARRAY(SELECT DISTINCT s FROM unnest(CASE WHEN COALESCE(cardinality(jobs.requested_stems), 0) = 0
                                                 THEN $6::text[] ELSE jobs.requested_stems END) AS u(s)
              ORDER BY s) = $4::text[]
  ORDER BY jobs.created_at DESC LIMIT 1`;

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
 * The newest live job of this user for this (canonical) URL, or null. Shared by Re-make's hooks
 * and the pasted-link hooks below (#372); read-only.
 */
export async function findLiveJobByUrl(db: Queryable, userId: string, url: string): Promise<string | null> {
  const r = await db.query(LIVE_JOB_BY_URL_SQL, liveJobParams(userId, url));
  return (r.rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Re-make's hooks for createAuthedLinkJob (B0, D-e). NEITHER writes the entry.
 * SEMANTICS (kept in #372 R2): Re-make has no stem or loop-length choice, so it reuses the
 * newest live job of this user + URL WHATEVER its stems / bars (any live copy of the song makes
 * it playable again); a new Re-make job gets the defaults (all six stems, 4 bars).
 *   findExisting: read-only, lock-free; the newest live job of this user + URL, or null.
 *   beforeInsert: inside the insert tx, immediately before the INSERT: lock the caller's
 *     entry row (FOR UPDATE) so two Re-makes of one entry serialise here, then take
 *     LINK_DEDUPE_LOCK_SQL (#372 R2: serialises with a paste of the same URL), then repeat the
 *     live-job lookup. The loser of a race waits for the winner's COMMIT, sees its job, and
 *     the tx rolls back with nothing spent (200 with that id). An entry that vanished (Removed
 *     meanwhile) throws EntryGone: the tx rolls back and the route answers 404.
 */
/**
 * The per-(user, canonical URL) lock every signed-in link-job creation for one URL takes in its
 * insert tx: a paste (pasteHooks) and a Re-make (remakeHooks, after its entry row). A
 * transaction-scoped advisory lock: there is no row to lock before the job exists, and it
 * releases at COMMIT / ROLLBACK. The 'link-dedupe:' namespace keeps it apart from every other
 * advisory key in this app (trial, quota, anon-caps, rate, set_lists, billing).
 * The key is user + URL, NOT the stem selection (#372 R2, deliberate): Re-make reuses a live job
 * of ANY selection, so a Re-make must serialise with a paste of every selection; a coarser key
 * only ever adds waiting between two creations of one user's one link, never a missed dedupe.
 */
export const LINK_DEDUPE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('link-dedupe:' || $1::text || ':' || $2::text, 0))`;

export function remakeHooks(entryId: string, userId: string) {
  return {
    findExisting: async (db: Queryable, ctx: { userId: string; canonicalUrl: string }): Promise<string | null> =>
      findLiveJobByUrl(db, ctx.userId, ctx.canonicalUrl),
    beforeInsert: async (client: Queryable, ctx: { userId: string; canonicalUrl: string }): Promise<string | null> => {
      const lock = await client.query(
        `SELECT id FROM library_entries WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
        [entryId, userId],
      );
      if (!lock.rows.length) throw new EntryGone();
      // #372 R2: the same per-(user, URL) key a paste takes, so a Re-make racing a paste of the
      // same link serialises with it (order: trial → entry row → link-dedupe → entitlements).
      await client.query(LINK_DEDUPE_LOCK_SQL, [ctx.userId, ctx.canonicalUrl]);
      return findLiveJobByUrl(client, ctx.userId, ctx.canonicalUrl);
    },
  };
}

type HookCtx = { userId: string; canonicalUrl: string; requestedStems: readonly string[]; loopLengthBars: number };

/** The paste lookup: live job of this user + URL with the same stem set and loop length,
 *  other than the `skipped` ids (QW-2). */
export async function findLiveJobForPaste(
  db: Queryable,
  ctx: HookCtx,
  skipped: readonly string[] = [],
): Promise<{ id: string; status: string } | null> {
  const r = await db.query(LIVE_JOB_BY_URL_AND_SELECTION_SQL, [
    ctx.userId, ctx.canonicalUrl, IN_FLIGHT_STATUSES, normaliseStems(ctx.requestedStems), ctx.loopLengthBars,
    [...LINK_DEFAULT_STEMS], [...skipped],
  ]);
  return (r.rows[0] as { id: string; status: string } | undefined) ?? null;
}

/** QW-2: at most this many unplayable done jobs are skipped per lookup; past it, a new job. */
export const PASTE_MAX_SKIPPED = 3;

/** true = playable; false = cannot play; null = could not tell (treated as playable). */
export type StemProbe = (jobId: string) => Promise<boolean | null>;

/**
 * QW-2: the paste's reuse decision. An IN-FLIGHT hit is reused as before. A DONE hit is reused
 * only if it can still play: the probe lists its play-along stems in R2; a job whose encoder
 * failed (`encode_failed`: downloads, no playback) or whose objects are gone answers false, is
 * skipped, and the lookup repeats for an older live job of the same selection. None left → null
 * → a new job, funded and metered exactly like any new paste (no retry_of: "Try again" is only
 * for FAILED jobs, which the predicate already never reuses). `verdicts` caches per request, so
 * beforeInsert's repeat costs no second probe for a job findExisting already judged.
 */
async function findUsableJobForPaste(
  db: Queryable,
  ctx: HookCtx,
  probe: StemProbe,
  verdicts: Map<string, boolean>,
  skipped: string[] = [],
): Promise<string | null> {
  for (;;) {
    const hit = await findLiveJobForPaste(db, ctx, skipped);
    if (!hit) return null;
    if (hit.status !== 'done') return hit.id;
    let ok = verdicts.get(hit.id);
    if (ok === undefined) {
      ok = (await probe(hit.id)) !== false; // null (could not tell) → reuse: never a double charge
      verdicts.set(hit.id, ok);
      if (!ok) console.warn('paste dedupe: skipping a done job with no playable stems', { jobId: hit.id });
    }
    if (ok) return hit.id;
    skipped.push(hit.id);
    if (skipped.length >= PASTE_MAX_SKIPPED) return null;
  }
}

/**
 * POST /api/jobs's hooks for a SIGNED-IN pasted link (#372: a double tap, two tabs or a client
 * retry made two jobs and spent two songs). Reuse the newest job of this user + canonical URL
 * that is in flight (IN_FLIGHT_STATUSES) or done and retained (JOB_RETAINED_UNTIL_SQL > now())
 * AND asks for the same loops (same stem set, same loop length; R2 MF-1). A FAILED (or expired,
 * or cancelled) job is NOT live, so a re-paste after a failure is a fresh, normally charged job;
 * so is a re-paste with a different stem selection. QW-2: neither is a DONE job that cannot
 * play (encoder failed, or its stems are gone; findUsableJobForPaste above).
 *   findExisting: read-only, lock-free. A hit answers 200 { id, existing: true } before every
 *     gate that writes (no burst row, quota, trial or debit).
 *   beforeInsert: inside the insert tx, immediately before the INSERT: take LINK_DEDUPE_LOCK_SQL
 *     for (user, canonical URL), then repeat the lookup. Two concurrent pastes (or a paste and a
 *     Re-make) serialise on the lock; the loser waits for the winner's COMMIT, sees its job, and
 *     its tx rolls back with nothing spent (an undone trial consume included).
 * LOCK ORDER (D-e: trial_grants → the hook's lock → entitlements): in the trial branch this lock
 * comes after consumeTrialInTx's trial lock; in the non-trial branch it is the tx's first lock;
 * in both it is taken before the INSERT and before rollPeriodIfStale / bumpJobsUsed[WithinQuota]
 * / recordAllowanceDebit take the entitlements / quota locks. Re-make takes it after its entry
 * row; a paste never takes an entry row and nothing else takes this key, so there is no cycle.
 */
/*
 * #494 item 1 (Jon, 11-26: no charge for a re-paste after our own encode failure; E1 = (a), no
 * migration). `repasteSources` hands createAuthedLinkJob the DONE jobs findExisting skipped as
 * unplayable (probe === false only; "could not tell" is reused, never skipped), newest first. The
 * lib funds the new job from the newest of them whose job_allowance_debits row is still unclaimed
 * (lib/jobs/create-link-job.ts, FREE RE-PASTE). Empty when findExisting hit or skipped nothing.
 */
export function pasteHooks(opts: { clientIpHash?: () => string; probe?: StemProbe } = {}) {
  const ipHash = opts.clientIpHash ?? (() => { throw new Error('no client IP hash'); });
  const probe: StemProbe = opts.probe ?? ((jobId) => hasPlayableStems(jobId, ipHash));
  const verdicts = new Map<string, boolean>();
  let unplayable: string[] = [];
  return {
    findExisting: async (db: Queryable, ctx: HookCtx): Promise<string | null> => {
      const skipped: string[] = [];
      const hit = await findUsableJobForPaste(db, ctx, probe, verdicts, skipped);
      unplayable = hit ? [] : skipped;
      return hit;
    },
    repasteSources: (): readonly string[] => [...unplayable],
    beforeInsert: async (client: Queryable, ctx: HookCtx): Promise<string | null> => {
      await client.query(LINK_DEDUPE_LOCK_SQL, [ctx.userId, ctx.canonicalUrl]);
      return findUsableJobForPaste(client, ctx, probe, verdicts);
    },
  };
}
