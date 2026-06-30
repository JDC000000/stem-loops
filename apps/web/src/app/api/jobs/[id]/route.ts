import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

const R2_ENDPOINT = process.env.R2_ENDPOINT ?? '';
const R2_BUCKET = process.env.R2_BUCKET_NAME ?? 'stem-loops-dev';

// Build a loop URL from its r2_key. Phase 1 returns a direct dev URL; Phase 2 (T17)
// re-mints a fresh signed URL on every read.
function loopUrl(r2Key: string): string {
  if (R2_ENDPOINT) return `${R2_ENDPOINT.replace(/\/$/, '')}/${R2_BUCKET}/${r2Key}`;
  return `https://${R2_BUCKET}.r2.cloudflarestorage.com/${r2Key}`;
}

// GET /api/jobs/:id — status + events + loops, read straight from Postgres.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const jobRes = await db.query(
      `SELECT id, youtube_url, requested_stems, loop_length_bars, status, error_code,
              error_message_user, bpm, musical_key, created_at, updated_at, expires_at
       FROM jobs WHERE id = $1`,
      [params.id]
    );
    if (jobRes.rowCount === 0) {
      return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
    }
    const job = jobRes.rows[0];

    const eventsRes = await db.query(
      `SELECT stage, phase, pct, created_at FROM job_events WHERE job_id = $1 ORDER BY created_at ASC`,
      [params.id]
    );

    const loopsRes = await db.query(
      `SELECT id, stem, section_label, energy_class, bar_count, bpm, musical_key,
              r2_key, filename, duration_ms
       FROM loops WHERE job_id = $1 ORDER BY stem, start_sec`,
      [params.id]
    );

    const loops = loopsRes.rows.map((l) => ({
      id: l.id,
      stem: l.stem,
      section_label: l.section_label,
      energy_class: l.energy_class,
      bar_count: l.bar_count,
      loop_length_bars: l.bar_count, // UI alias
      bpm: l.bpm,
      musical_key: l.musical_key,
      filename: l.filename,
      duration_ms: l.duration_ms,
      r2_url: loopUrl(l.r2_key),
    }));

    return NextResponse.json({ ...job, events: eventsRes.rows, loops });
  } catch (err) {
    console.error(`GET /api/jobs/${params.id} error:`, err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
