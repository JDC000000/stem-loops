import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { enqueueJob } from '@/lib/queue';

const IP_HASH_KEY = process.env.IP_HASH_KEY ?? 'dev-key';
const VALID_BARS = new Set([1, 2, 4, 8]);
const DEFAULT_STEMS = ['vocals', 'drums', 'bass', 'other'];

function hashIp(ip: string): string {
  return createHash('sha256').update(IP_HASH_KEY + ip).digest('hex');
}

// POST /api/jobs — validate + canonicalize URL, INSERT jobs (status=queued),
// enqueue. The Python worker claims via FOR UPDATE SKIP LOCKED (Gate 0 S2 / option a).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, stems, loop_length_bars } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error_code: 'DOWNLOAD_INVALID_URL', message: 'url is required' }, { status: 400 });
    }
    if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'Only YouTube URLs are supported' },
        { status: 400 }
      );
    }
    const bars = loop_length_bars ?? 4;
    if (!VALID_BARS.has(bars)) {
      return NextResponse.json(
        { error_code: 'DOWNLOAD_INVALID_URL', message: 'loop_length_bars must be 1, 2, 4, or 8' },
        { status: 400 }
      );
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      '0.0.0.0';
    const clientIpHash = hashIp(ip);
    const id = randomUUID();
    const requestedStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;

    await db.query(
      `INSERT INTO jobs (id, youtube_url, requested_stems, loop_length_bars, status, client_ip_hash, client_fingerprint)
       VALUES ($1, $2, $3, $4, 'queued', $5, '')`,
      [id, url, requestedStems, bars, clientIpHash]
    );

    // pg-boss enqueue (retry/scheduling semantics). The worker also polls
    // jobs.status, so a transient enqueue failure must not lose the job.
    try {
      await enqueueJob(id);
    } catch (e) {
      console.error('enqueueJob failed (job still claimable via status):', e);
    }

    return NextResponse.json({ id, status: 'queued' }, { status: 201 });
  } catch (err) {
    console.error('POST /api/jobs error:', err);
    return NextResponse.json({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }, { status: 500 });
  }
}
