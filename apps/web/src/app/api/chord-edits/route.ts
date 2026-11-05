// POST /api/chord-edits — PR-Y1.7 flywheel seed (TSD §1.6a).
//
// The chord overlay posts one user correction per call. The row is the
// authoritative training signal; the DB writes it directly under
// stemloops_app INSERT policy from migration 025, so RLS (`WITH CHECK
// (auth.uid() = user_id)`) + the server-side user_id resolution together
// guarantee a client cannot post as another user.
//
// Rate limit: 60 edits per user per hour. There is no in-repo generic
// per-user rate-limit middleware; the two paths today are
//   • lib/admission.ts            — per-IP, used by job start
//   • lib/billing/rate-limit.ts   — per-user, keyed on usage_events table
// Reusing the latter would mint a usage_event row for a non-billable
// action; rolling our own append-only table here would be out of scope.
// Phase choice: a direct `SELECT count` of this user's recent chord_edits.
// The chord_edits table is append-only (migration 025 REVOKEs UPDATE/DELETE
// from stemloops_app) so the counter cannot be erased from the app role.
// TODO(Phase 2 follow-up): swap to a hashed-counter row when a generic
// per-user rate-limit middleware lands (tracked in project-tracker.md
// under "Structural").

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { getUser } from '@/lib/auth/supabase';

const HARTE_RE = /^(N|X|[A-G](#|b)?(:[a-z0-9]+)?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['klangio', 'internal', 'autochord']);
const RATE_LIMIT_PER_HOUR = 60;

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
  if (!track_hash) return { ok: false, res: bad('CHORD_EDIT_INVALID', 'track_hash is required.') };
  if (start_sec === undefined || end_sec === undefined) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'start_sec and end_sec are required numbers.') };
  }
  if (end_sec <= start_sec) {
    return { ok: false, res: bad('CHORD_EDIT_TIME_RANGE', 'end_sec must be > start_sec.') };
  }
  if (!original_label) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'original_label is required.') };
  }
  if (!corrected_label || !HARTE_RE.test(corrected_label)) {
    return { ok: false, res: bad('CHORD_EDIT_HARTE', 'corrected_label must be a valid Harte label.') };
  }
  if (original_label === corrected_label) {
    return { ok: false, res: bad('CHORD_EDIT_SAME_LABEL', 'original and corrected labels must differ.') };
  }
  if (!provider || !PROVIDERS.has(provider)) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'provider must be klangio|internal|autochord.') };
  }
  if (!provider_version) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'provider_version is required.') };
  }
  if (!alphabet_sha) {
    return { ok: false, res: bad('CHORD_EDIT_INVALID', 'alphabet_sha is required.') };
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

    // Rate limit: COUNT recent edits by this user. chord_edits is
    // append-only at the app role, so the counter cannot be forged.
    const recent = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM public.chord_edits
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
      [user.user_id],
    );
    if ((recent.rows[0]?.count ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        {
          error_code: 'RATE_LIMITED',
          message: 'Too many chord edits in the last hour. Try again later.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '3600' },
        },
      );
    }

    // Atomic insert — the DB CHECK constraints (migration 025) are the
    // authoritative validator. If a malformed row sneaks past the Zod-shape
    // check above, the DB rejects it and we surface that as a 400.
    let ins;
    try {
      ins = await db.query<{ id: string; created_at: string }>(
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
    } catch (err) {
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
