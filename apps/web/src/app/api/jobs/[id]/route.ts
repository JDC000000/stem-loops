import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { mintSignedUrl } from '@/lib/r2';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const jobRes = await db.query('SELECT * FROM jobs WHERE id=$1', [params.id]);
  const job = jobRes.rows[0];
  if (!job) {
    return NextResponse.json({ error_code: 'NOT_FOUND', message: 'Job not found' }, { status: 404 });
  }

  const eventsRes = await db.query(
    'SELECT * FROM job_events WHERE job_id=$1 ORDER BY created_at ASC',
    [params.id],
  );
  const loopsRes = await db.query('SELECT * FROM loops WHERE job_id=$1', [params.id]);

  // Re-mint signed URLs on every read (7-day TTL) — PRD §8 anti-goal #4.
  const loops = await Promise.all(
    loopsRes.rows.map(async (loop) => ({ ...loop, signed_url: await mintSignedUrl(loop.r2_key) })),
  );

  // NEVER leak job_events.detail (redacted server-side trace) to the client.
  const events = eventsRes.rows.map(({ detail: _detail, ...rest }) => rest);

  return NextResponse.json({
    job: {
      ...job,
      error_message_user: job.error_message_user ?? null,
      events,
      loops,
    },
  });
}
