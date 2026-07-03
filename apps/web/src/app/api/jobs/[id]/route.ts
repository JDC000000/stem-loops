import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { mintSignedUrl } from '@/lib/r2';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/jobs/:id — status + events + loops, read straight from Postgres.
// Each loop gets a FRESHLY minted signed URL on every read (PRD §8 anti-goal #4).
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
      `SELECT id, input_kind, youtube_url, upload_r2_key, original_filename, requested_stems,
              loop_length_bars, status, error_code, error_message_user, bpm, musical_key,
              created_at, updated_at, expires_at
       FROM jobs WHERE id = $1`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const job = jobRes.rows[0];

    const eventsRes = await db.query(
      `SELECT id, job_id, stage, phase, pct, duration_ms, created_at
       FROM job_events WHERE job_id = $1 ORDER BY created_at ASC`,
      [params.id]
    );

    const loopsRes = await db.query(
      `SELECT id, job_id, stem, section_label, energy_class, start_sec, end_sec, start_bar,
              bar_count, bpm, musical_key, r2_key, filename, duration_ms, waveform_peaks, created_at
       FROM loops WHERE job_id = $1 ORDER BY stem, start_sec`,
      [params.id]
    );

    const loops = await Promise.all(
      loopsRes.rows.map(async (l) => {
        let signed_url: string | null = null;
        try {
          signed_url = await mintSignedUrl(l.r2_key, l.filename);
        } catch (e) {
          console.error('mintSignedUrl failed for', l.r2_key, e);
        }
        return { ...l, signed_url };
      })
    );

    return NextResponse.json({ ...job, events: eventsRes.rows, loops });
  } catch (err) {
    console.error(`GET /api/jobs/${params.id} error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
