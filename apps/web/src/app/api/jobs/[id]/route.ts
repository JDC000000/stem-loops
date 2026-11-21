import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { mintSignedUrl } from '@/lib/r2';
import { JOB_RETAINED_UNTIL_SQL, presignTtlSec } from '@/lib/retention';
import { mayActOnJob, mayReadJob } from '@/lib/job-access';
import { demoReadAllowed, DEMO_RATE_LIMIT_MSG } from '@/lib/demo-rate';
import { inputTrimFromEvents } from '@/lib/input-trim';
import { clientIpHashOf } from '@/lib/client-ip';
import { admitJobRead, jobReadRetryAfterSec } from '@/lib/read-rate-limit';
// OWNERSHIP: a job with a user_id is readable only by that user; an anonymous job
// (user_id NULL) is readable by anyone holding its id; a DEMO song (is_demo, Slice 2a,
// DB-12a) is readable by everyone, signed out included, and its reads are rate-limited
// per IP (lib/demo-rate.ts, read-only). See lib/job-access.ts. A denied
// caller gets the same 404 as a missing job. `user_id` is read to decide that and is
// NEVER copied into the response. The body therefore also varies by who is signed in,
// which is a second reason for NO_STORE below.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The body carries a freshly minted signed URL per cut loop (a bearer credential valid for
// up to the job's remaining life). Same rule as ../stems and ../play-chords (#185): never
// let a shared cache store it, which Next's default `public, max-age=0, must-revalidate` permits.
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

// Dropped from a demo song's response for everyone but its owner (review S1): where the
// operator's upload lives and what the file was called, and each loop's storage key and file
// name. The player reads none of them (title comes from the catalog; sections from
// section_label / start_sec / end_sec / bpm).
const DEMO_OWNER_ONLY_JOB_FIELDS = ['upload_r2_key', 'original_filename', 'youtube_url'] as const;
const DEMO_OWNER_ONLY_LOOP_FIELDS = ['r2_key', 'filename'] as const;

// GET /api/jobs/:id — status + events + loops, read straight from Postgres.
// Each loop gets a FRESHLY minted signed URL on every read (PRD §8 anti-goal #4), valid for
// at most the job's remaining life, capped at 24h. "Remaining life" is JOB_RETAINED_UNTIL_SQL
// (24h for Free, longer for a Pro/Studio owner; lib/retention.ts), returned AS expires_at.
// Past it the job is treated as gone even if the sweep hasn't run yet. `is_demo` (migration
// 040) is returned so the player can hide "deleted in …" for a demo song, whose expires_at is
// the far-future DEMO_RETAINED_UNTIL. Since Slice 2a it also opens the READ path for that row
// (lib/job-access.ts); nothing else about the response changes.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // A shape-invalid id (mistyped/truncated bookmark) would otherwise hit Postgres's
  // uuid-cast error → generic 500, which the client poll loop treats as non-terminal
  // and retries forever ("Processing... 0%" loop, QA P1). Return the clean 404 the UI
  // already handles, matching the UUID_RE guard POST /api/jobs already uses.
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404, headers: NO_STORE });
  }
  try {
    // QA track B, B-11: per-IP read limiter BEFORE any database work (lib/read-rate-limit.ts).
    const readKey = clientIpHashOf(request);
    if (!admitJobRead(readKey)) {
      return NextResponse.json(
        { error_code: 'RATE_LIMITED', message: "You're sending requests too fast. Wait a minute and try again." },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(jobReadRetryAfterSec(readKey)) } },
      );
    }
    const jobRes = await db.query(
      `SELECT user_id, id, input_kind, youtube_url, upload_r2_key, original_filename, title, requested_stems,
              loop_length_bars, status, error_code, error_message_user, bpm, musical_key,
              created_at, updated_at, is_demo, ${JOB_RETAINED_UNTIL_SQL} AS expires_at
       FROM jobs WHERE id = $1 AND ${JOB_RETAINED_UNTIL_SQL} > now()`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404, headers: NO_STORE });
    }
    const { user_id: ownerId, ...job } = jobRes.rows[0];
    if (!(await mayReadJob(ownerId, job.is_demo))) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404, headers: NO_STORE });
    }
    // Demo songs only: the per-IP read limit (design P3.1). An ordinary job never gets here.
    if (job.is_demo === true && !(await demoReadAllowed(request))) {
      return NextResponse.json(
        { error_code: 'RATE_LIMITED', message: DEMO_RATE_LIMIT_MSG },
        { status: 429, headers: NO_STORE },
      );
    }
    // THE PUBLIC DEMO VIEW (Slice 2a review F1, S1). A demo song read by anyone but its owner
    // (the demo system account) gets what the player needs and nothing else: no signed loop
    // URL (a cut demo loop is a 24 h WAV download, and P3.1 makes demo loops owner-only), no
    // storage key and no upload metadata. The decision is the central rule's `download` cell,
    // so an orphaned demo (owner deleted) is public to everyone. An ordinary job never enters
    // this branch, so its response is unchanged.
    const publicDemoView = job.is_demo === true && !(await mayActOnJob('download', { ownerId, isDemo: true }));
    if (publicDemoView) {
      for (const field of DEMO_OWNER_ONLY_JOB_FIELDS) delete (job as Record<string, unknown>)[field];
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
    // ONE source of truth for the key (Phase A, J3). Loop rows copy the job's
    // key when the worker writes them (pipeline.record_loops), so a loop row
    // that disagrees is stale: rows written before #295 carry the key detected
    // on the drums stem, and the demo rows' job key was corrected in place
    // (2026-11-18) while their loop rows were not. The job row wins; a loop row
    // keeps its own key only when the job has none.
    const jobKey: unknown = job.musical_key;
    const loops = await Promise.all(
      loopsRes.rows.map(async (row) => {
        const l = typeof jobKey === 'string' && jobKey.trim() !== '' ? { ...row, musical_key: jobKey } : row;
        if (publicDemoView) {
          const pub: Record<string, unknown> = { ...l, signed_url: null };
          for (const field of DEMO_OWNER_ONLY_LOOP_FIELDS) delete pub[field];
          return pub;
        }
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
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
