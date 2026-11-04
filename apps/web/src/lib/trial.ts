// Trial grant/consume helpers — V3 Phase 1a (TSD §1.6, V3-C10).
//
// Shared SQL for the trial_grants table (migration 013 §13):
//   trial_grants(user_id PK, granted_at, songs_used 0..3, expires_at default
//   granted_at + 7 days). RLS: per-user self-read + stemloops_app FOR ALL.
//
// Three operations live here so the HTTP routes and the job-create path can
// share the same contract:
//
//   grantTrial(userId)    INSERT ... ON CONFLICT DO NOTHING → RETURNING *
//                         Idempotent: PK=user_id means a re-call reads the
//                         existing row. Returns granted=false when the row
//                         already existed.
//
//   consumeTrial(userId)  Advisory-locked UPDATE under hashtext(
//                         'trial_consume:' || user_id). Increments songs_used
//                         by 1, with the row-level CHECK (songs_used <= 3)
//                         catching the "no trial left" case. Also refuses
//                         when expires_at <= now(). Returns the result shape
//                         below; caller decides whether to allow the job.
//
//   readTrial(userId)     SELECT one row (no mutation). Powers the /trial
//                         page's "already have a trial?" branch and the
//                         /pricing banner's "hide if used" check.
//
// All three functions treat a missing row as "no trial yet" — consume is the
// only one that touches state; grant is the only one that creates it.

import { db } from '@/lib/db';

export const TRIAL_SONG_CAP = 3;

/** DB row shape. expires_at stays a timestamptz string from the driver. */
type TrialRow = {
  user_id: string;
  granted_at: string;
  songs_used: number;
  expires_at: string;
};

export type GrantResult = {
  /** true when this call inserted the row; false when a prior row already existed. */
  granted: boolean;
  songs_remaining: number;
  expires_at: string;
  /** true when expires_at <= now(). A pre-existing expired row re-reads as expired. */
  expired: boolean;
};

export type ConsumeOutcome =
  | { ok: true; songs_remaining: number; expires_at: string }
  | { ok: false; reason: 'no_grant' | 'expired' | 'exhausted' };

export type TrialState =
  | { present: false }
  | {
      present: true;
      songs_remaining: number;
      expires_at: string;
      /** true when expires_at <= now(). */
      expired: boolean;
    };

/** Postgres advisory-lock namespace tag per the spec. */
const CONSUME_LOCK_TAG = 'trial_consume';

/**
 * Minimal client shape consumeTrialInTx needs. Matches the `client` arg
 * db.tx() passes into its callback, so the caller can share one tx with
 * follow-up writes (e.g. INSERT INTO jobs) that must roll back together.
 */
type TxClient = {
  query<R extends { [k: string]: unknown } = { [k: string]: unknown }>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

/** Idempotent grant: INSERT with ON CONFLICT DO NOTHING. The follow-up
 *  SELECT is unconditional so a re-call that was a no-op still gets the
 *  current state to return (granted=false). Runs in one tx so the SELECT
 *  cannot race with a concurrent delete between the two statements. */
export async function grantTrial(userId: string): Promise<GrantResult> {
  return db.tx(async (client) => {
    const ins = await client.query<TrialRow>(
      `INSERT INTO public.trial_grants (user_id)
       VALUES ($1::uuid)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id, granted_at, songs_used, expires_at`,
      [userId],
    );
    let row: TrialRow | undefined = ins.rows[0];
    const granted = ins.rowCount === 1;
    if (!row) {
      const sel = await client.query<TrialRow>(
        `SELECT user_id, granted_at, songs_used, expires_at
           FROM public.trial_grants WHERE user_id = $1::uuid`,
        [userId],
      );
      row = sel.rows[0];
    }
    if (!row) {
      // Extremely rare: the INSERT reported a conflict but the row
      // vanished before the SELECT. Report as "not granted" with a 0-left
      // state rather than throw — the caller surfaces this as a 503.
      return {
        granted: false,
        songs_remaining: 0,
        expires_at: new Date(0).toISOString(),
        expired: true,
      };
    }
    const songsRemaining = Math.max(0, TRIAL_SONG_CAP - row.songs_used);
    const expired = new Date(row.expires_at).getTime() <= Date.now();
    return {
      granted,
      songs_remaining: songsRemaining,
      expires_at: row.expires_at,
      expired,
    };
  });
}

/**
 * In-tx variant used by /api/jobs so the trial consume and the jobs INSERT
 * share a single tx (PR #39 Lens A). If the caller then throws (e.g. the
 * atomic rate-limit WHERE returns 0 rows), the tx rolls back and the trial
 * song is NOT burned. Same body as consumeTrial — the outer db.tx() just
 * moves up to the caller.
 */
export async function consumeTrialInTx(
  client: TxClient,
  userId: string,
): Promise<ConsumeOutcome> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
    [CONSUME_LOCK_TAG, userId],
  );
  const upd = await client.query<TrialRow>(
    `UPDATE public.trial_grants
        SET songs_used = songs_used + 1
      WHERE user_id = $1::uuid
        AND songs_used < ${TRIAL_SONG_CAP}
        AND expires_at > now()
      RETURNING user_id, granted_at, songs_used, expires_at`,
    [userId],
  );
  if (upd.rowCount === 1) {
    const row = upd.rows[0];
    return {
      ok: true,
      songs_remaining: Math.max(0, TRIAL_SONG_CAP - row.songs_used),
      expires_at: row.expires_at,
    };
  }
  // Zero-row update: figure out why.
  const sel = await client.query<TrialRow>(
    `SELECT user_id, granted_at, songs_used, expires_at
       FROM public.trial_grants WHERE user_id = $1::uuid`,
    [userId],
  );
  const row = sel.rows[0];
  if (!row) return { ok: false, reason: 'no_grant' };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: false, reason: 'exhausted' };
}

/** Atomic decrement: take the per-user advisory lock, then UPDATE the one
 *  row with the guards baked in (songs_used < 3 AND expires_at > now()).
 *  If 0 rows were updated, the follow-up SELECT distinguishes the three
 *  denial reasons for the caller.
 *
 *  Stand-alone callers (e.g. the /api/users/me/trial/consume route, used
 *  by the UI) should use this version; callers that need to combine the
 *  consume with another write (so both roll back together) use
 *  consumeTrialInTx() above directly inside their own db.tx(). */
export async function consumeTrial(userId: string): Promise<ConsumeOutcome> {
  return db.tx(async (client) => consumeTrialInTx(client, userId));
}

/** Non-mutating read for UI branches (pricing banner, /trial page). */
export async function readTrial(userId: string): Promise<TrialState> {
  const r = await db.query<TrialRow>(
    `SELECT user_id, granted_at, songs_used, expires_at
       FROM public.trial_grants WHERE user_id = $1::uuid`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { present: false };
  return {
    present: true,
    songs_remaining: Math.max(0, TRIAL_SONG_CAP - row.songs_used),
    expires_at: row.expires_at,
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  };
}
