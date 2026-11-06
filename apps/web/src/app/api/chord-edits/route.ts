// POST /api/chord-edits — PR-Y1.7 flywheel seed (TSD §1.6a).
//
// Security guarantees (session-6 audit v2 finding F3):
//
// 1. OWNERSHIP. The caller's Supabase session resolves `user_id` server-side
//    (getUser(), not getSession()), AND we verify that the submitted
//    `job_id` belongs to that user before INSERT. A missing or foreign
//    job_id returns 404 CHORD_EDIT_INVALID — the client cannot plant edits
//    against another user's job.
// 2. VALIDATION. All text fields have hard length caps (track_hash +
//    alphabet_sha are 64-hex; provider_version, cqt_plan_version ≤ 64;
//    labels ≤ 16). Both start_sec and end_sec are clamped to [0, 86400]
//    so pathological payloads (e.g. 1e12) cannot overflow numeric(10, 3)
//    and surface as a 500.
// 3. RATE LIMIT. 60 edits / user / hour, enforced inside a tx under
//    pg_advisory_xact_lock(hashtext('chord_edit:'||user_id)) so parallel
//    requests cannot all pass the COUNT check before any INSERT commits.
// 4. DEFENCE-IN-DEPTH. Migration 026 adds CHECK constraints mirroring (2)
//    at the DB layer so a bypass (e.g. PostgREST direct from a compromised
//    JWT) still fails fast.
//
// Note on RLS: this route executes as the `stemloops_app` role whose
// INSERT policy is `WITH CHECK (true)` (migration 025). The authenticated
// `WITH CHECK (auth.uid() = user_id)` policy only applies when a client
// uses a Supabase user JWT directly. The practical guarantee for THIS
// code path is the ownership check above, not RLS. Document and preserve
// both together.

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';
// Shared with chord/edit-collector.ts; mirrors chord_source.py and migration 029.
import { HARTE_RE } from '@/chord/harte';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PROVIDERS = new Set(['klangio', 'internal', 'autochord']);
const RATE_LIMIT_PER_HOUR = 60;

// Length / range caps (mirror migration 026).
const MAX_PROVIDER_VERSION = 64;
const MAX_CQT_PLAN_VERSION = 64;
const MAX_LABEL_LEN = 16;
const MIN_SEC = 0;
const MAX_SEC = 86400; // 24 h — longest plausible track + margin.

// Advisory-lock namespace tag. Partitioned from billing locks (see
// apps/web/src/lib/billing/rate-limit.ts).
const RATE_LIMIT_LOCK_TAG = 'chord_edit_rate_limit';

interface ChordEditBody {
  job_id: string;
  track_hash: string;
  start_sec: number;
  end_sec: number;
  original_label: string;
  corrected_label: string;
  original_confidence?: number;
  provider: string;
  provider_version: string;
  cqt_plan_version?: string;
  alphabet_sha: string;
}

function bad(code: string, message: string, status = 400): NextResponse {
  return NextResponse.json({ error_code: code, message }, { status });
}

function parse(body: unknown): { ok: true; edit: ChordEditBody } | { ok: false; res: NextResponse } {
  if (!body || typeof body !== 'object') {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'Body must be a JSON object.') };
  }
  const b = body as Record<string, unknown>;

  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
  const num = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k] as number) ? (b[k] as number) : undefined);

  const job_id = str('job_id');
  const track_hash = str('track_hash');
  const original_label = str('original_label');
  const corrected_label = str('corrected_label');
  const provider = str('provider');
  const provider_version = str('provider_version');
  const alphabet_sha = str('alphabet_sha');
  const start_sec = num('start_sec');
  const end_sec = num('end_sec');

  if (!job_id || !UUID_RE.test(job_id)) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'job_id must be a UUID.') };
  }
  if (!track_hash || !SHA256_HEX_RE.test(track_hash)) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'track_hash must be 64 lowercase hex chars.') };
  }
  if (!alphabet_sha || !SHA256_HEX_RE.test(alphabet_sha)) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'alphabet_sha must be 64 lowercase hex chars.') };
  }
  if (start_sec === undefined || end_sec === undefined) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'start_sec and end_sec are required numbers.') };
  }
  if (start_sec < MIN_SEC || start_sec > MAX_SEC) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', `start_sec must be in [${MIN_SEC}, ${MAX_SEC}].`) };
  }
  if (end_sec < MIN_SEC || end_sec > MAX_SEC) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', `end_sec must be in [${MIN_SEC}, ${MAX_SEC}].`) };
  }
  if (end_sec <= start_sec) {
    return { ok: false, res: bad('CHORD_EDIT_TIME_RANGE', 'end_sec must be > start_sec.') };
  }
  if (!original_label || original_label.length > MAX_LABEL_LEN) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', `original_label must be 1..${MAX_LABEL_LEN} chars.`) };
  }
  if (!corrected_label || corrected_label.length > MAX_LABEL_LEN || !HARTE_RE.test(corrected_label)) {
    return { ok: false, res: bad('CHORD_EDIT_HARTE', 'corrected_label must be a valid Harte label.') };
  }
  if (original_label === corrected_label) {
    return { ok: false, res: bad('CHORD_EDIT_SAME_LABEL', 'original and corrected labels must differ.') };
  }
  if (!provider || !PROVIDERS.has(provider)) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'provider must be klangio|internal|autochord.') };
  }
  if (!provider_version || provider_version.length > MAX_PROVIDER_VERSION) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', `provider_version must be 1..${MAX_PROVIDER_VERSION} chars.`) };
  }
  const confRaw = b.original_confidence;
  let original_confidence: number | undefined;
  if (confRaw !== undefined && confRaw !== null) {
    if (typeof confRaw !== 'number' || !Number.isFinite(confRaw) || confRaw < 0 || confRaw > 1) {
      return { ok: false, res: bad('CHORD_EDIT_INVALID', 'original_confidence must be in [0, 1].') };
    }
    original_confidence = confRaw;
  }
  const cqt_plan_version = str('cqt_plan_version');
  if (cqt_plan_version !== undefined && cqt_plan_version.length > MAX_CQT_PLAN_VERSION) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', `cqt_plan_version must be ≤ ${MAX_CQT_PLAN_VERSION} chars.`) };
  }

  return {
    ok: true,
    edit: {
      job_id,
      track_hash,
      start_sec,
      end_sec,
      original_label,
      corrected_label,
      original_confidence,
      provider,
      provider_version,
      cqt_plan_version,
      alphabet_sha,
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getUser();
    if (!user) {
      return bad('UNAUTHENTICATED', 'Sign in to submit chord edits.', 401);
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return bad('CHORD_EDIT_INVALID', 'Request body must be valid JSON.');
    }
    const parsed = parse(raw);
    if (!parsed.ok) return parsed.res;
    const edit = parsed.edit;

    // Ownership: a client can only submit edits against jobs they own.
    // This is the primary guarantee — RLS on chord_edits does not apply
    // when the route runs under the stemloops_app role (WITH CHECK true).
    const own = await db.query(
      'SELECT 1 FROM public.jobs WHERE id = $1 AND user_id = $2',
      [edit.job_id, user.user_id],
    );
    if (!own.rowCount) {
      return bad('CHORD_EDIT_INVALID', 'Unknown job.', 404);
    }

    // Atomic rate-limit + INSERT inside one tx. Without the advisory lock,
    // N parallel requests can each pass the COUNT check (all seeing the
    // pre-insert counter) and then all succeed INSERTs — see audit v2 F3.
    // db.tx() wraps BEGIN/COMMIT and runs ROLLBACK on throw.
    let ins: Awaited<ReturnType<typeof db.query<{ id: string; created_at: string }>>>;
    try {
      ins = await db.tx(async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text))`,
          [RATE_LIMIT_LOCK_TAG, user.user_id],
        );
        const recent = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM public.chord_edits
            WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
          [user.user_id],
        );
        if ((recent.rows[0]?.count ?? 0) >= RATE_LIMIT_PER_HOUR) {
          // Encode the 429 as a sentinel the outer POST can translate.
          const err = new Error('rate_limited');
          (err as { __rate_limited?: boolean }).__rate_limited = true;
          throw err;
        }
        return client.query<{ id: string; created_at: string }>(
          `INSERT INTO public.chord_edits (
             user_id, job_id, track_hash, provider, provider_version,
             start_sec, end_sec, original_label, corrected_label,
             original_confidence, cqt_plan_version, alphabet_sha
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, created_at`,
          [
            user.user_id,
            edit.job_id,
            edit.track_hash,
            edit.provider,
            edit.provider_version,
            edit.start_sec,
            edit.end_sec,
            edit.original_label,
            edit.corrected_label,
            edit.original_confidence ?? null,
            edit.cqt_plan_version ?? null,
            edit.alphabet_sha,
          ],
        );
      });
    } catch (err) {
      if ((err as { __rate_limited?: boolean })?.__rate_limited) {
        return NextResponse.json(
          {
            error_code: 'RATE_LIMITED',
            message: 'Too many chord edits in the last hour. Try again later.',
          },
          { status: 429, headers: { 'Retry-After': '3600' } },
        );
      }
      // Postgres error code 23514 = check_violation, 23503 = fk_violation.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr?.code === '23514') {
        const codeByConstraint: Record<string, string> = {
          chord_edits_valid_time_range: 'CHORD_EDIT_TIME_RANGE',
          chord_edits_labels_differ: 'CHORD_EDIT_SAME_LABEL',
          chord_edits_valid_harte: 'CHORD_EDIT_HARTE',
        };
        const code = codeByConstraint[pgErr.constraint ?? ''] ?? 'CHORD_EDIT_INVALID';
        return bad(code, 'Chord edit violates a schema constraint.');
      }
      if (pgErr?.code === '23503') {
        return bad('CHORD_EDIT_INVALID', 'Referenced job or user is missing.');
      }
      throw err;
    }

    const row = ins.rows[0];
    return NextResponse.json({ edit_id: row.id, created_at: row.created_at }, { status: 201 });
  } catch (err) {
    Sentry.captureException(err);
    console.error('POST /api/chord-edits error:', err);
    return NextResponse.json(
      { error_code: 'INTERNAL_ERROR', message: 'Internal server error' },
      { status: 500 },
    );
  }
}
