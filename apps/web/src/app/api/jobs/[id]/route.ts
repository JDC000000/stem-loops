import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { mintSignedUrl } from '@/lib/r2';
import { presignTtlSec } from '@/lib/retention';
import { mayReadJob } from '@/lib/job-access';
import { inputTrimFromEvents } from '@/lib/input-trim';
// OWNERSHIP: a job with a user_id is readable only by that user; an anonymous job
// (user_id NULL) is readable by anyone holding its id. See lib/job-access.ts. A denied
// caller gets the same 404 as a missing job. `user_id` is read to decide that and is
// NEVER copied into the response. The body therefore also varies by who is signed in,
// which is a second reason for NO_STORE below.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The body carries a freshly minted signed URL per cut loop (a bearer credential valid for
// up to the job's remaining life). Same rule as ../stems and ../play-chords (#185): never
// let a shared cache store it, which Next's default `public, max-age=0, must-revalidate` permits.
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

// GET /api/jobs/:id — status + events + loops, read straight from Postgres.
// Each loop gets a FRESHLY minted signed URL on every read (PRD §8 anti-goal #4), valid for
// at most the job's remaining life (24h retention; the worker deletes the objects after
// expires_at). Past expires_at the job is treated as gone even if the sweep hasn't run yet.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  // A shape-invalid id (mistyped/truncated bookmark) would otherwise hit Postgres's
  // uuid-cast error → generic 500, which the client poll loop treats as non-terminal
  // and retries forever ("Processing... 0%" loop, QA P1). Return the clean 404 the UI
  // already handles, matching the UUID_RE guard POST /api/jobs already uses.
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }
  try {
    const jobRes = await db.query(
      `SELECT user_id, id, input_kind, youtube_url, upload_r2_key, original_filename, requested_stems,
              loop_length_bars, status, error_code, error_message_user, bpm, musical_key,
              created_at, updated_at, expires_at
       FROM jobs WHERE id = $1 AND expires_at > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const { user_id: ownerId, ...job } = jobRes.rows[0];
    if (!(await mayReadJob(ownerId))) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const urlTtlSec = presignTtlSec(job.expires_at);

    // `detail` is read ONLY to find the input trim (lib/input-trim.ts) and is then dropped
    // from every event: on other events it carries `cost_usd`, which never goes to a browser.
    const eventsRes = await db.query(
      `SELECT id, job_id, stage, phase, pct, duration_ms, detail, created_at
       FROM job_events WHERE job_id = $1 ORDER BY created_at ASC`,
      [params.id]
    );
    const trim = inputTrimFromEvents(eventsRes.rows);
    const events = eventsRes.rows.map((e: Record<string, unknown>) => {
      const rest = { ...e };
      delete rest.detail;
      return rest;
    });

    const loopsRes = await db.query(
      `SELECT id, job_id, stem, section_label, energy_class, start_sec, end_sec, start_bar,
              bar_count, bpm, musical_key, r2_key, filename, duration_ms, waveform_peaks,
              cut_at, created_at
       FROM loops WHERE job_id = $1 ORDER BY stem, start_sec`,
      [params.id]
    );

    // Migration 033: a loop row with `cut_at = null` is DESCRIBED but not CUT —
    // the pipeline records every loop and encodes none of them until a user asks
    // (`POST /api/jobs/:id/loops`). Its `r2_key` names where the WAV *will* live,
    // so signing it would hand the client a URL that 404s, which the UI cannot
    // tell from an expired job. An uncut row therefore carries `signed_url: null`
    // and nothing else about it changes — the play-along player reads only
    // `section_label` / `start_sec` / `end_sec` (lib/play/sections.ts) and is
    // served in full by an uncut row.
    const loops = await Promise.all(
      loopsRes.rows.map(async (l) => {
        if (l.cut_at === null || l.cut_at === undefined) return { ...l, signed_url: null };
        let signed_url: string | null = null;
        try {
          signed_url = await mintSignedUrl(l.r2_key, l.filename, urlTtlSec);
        } catch (e) {
          Sentry.captureException(e);
          console.error('mintSignedUrl failed for', l.r2_key, e);
        }
        return { ...l, signed_url };
      })
    );

    return NextResponse.json(
      {
        ...job,
        input_trim_used_sec: trim?.usedSec ?? null,
        input_trim_source_sec: trim?.sourceSec ?? null,
        events,
        loops,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    Sentry.captureException(err);
    console.error(`GET /api/jobs/${params.id} error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
