import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { enqueueJob } from '@/lib/queue';
import { checkAdmission } from '@/lib/admission';

const IP_HASH_KEY = process.env.IP_HASH_KEY ?? 'dev-key';
const VALID_BARS = new Set([1, 2, 4, 8]);
const DEFAULT_STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_MSG =
  "You're going a bit fast, or we're at capacity right now. Give it a minute and try again.";

function hashIp(ip: string): string {
  return createHash('sha256').update(IP_HASH_KEY + ip).digest('hex');
}

function clientIpHashOf(request: NextRequest): string {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '0.0.0.0';
  return hashIp(ip);
}

// POST /api/jobs — create a job. Two input kinds:
//   • upload  (V2 PRIMARY): body { jobId, uploadKey, filename?, stems?, loop_length_bars? }
//     — file already PUT to R2 by the browser (see POST /api/uploads).
//   • youtube (DEFERRED/parked): body { url, ... }.
// The Python worker claims via FOR UPDATE SKIP LOCKED (Gate 0 S2 / option a).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // ── Upload job ──────────────────────────────────────────────────────────
    if (body.uploadKey) {
      const { jobId, uploadKey, filename, stems, loop_length_bars } = body;
      if (typeof jobId !== 'string' || !UUID_RE.test(jobId) || typeof uploadKey !== 'string') {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'Missing or invalid upload reference.' },
          { status: 400 }
        );
      }
      const ubars = loop_length_bars ?? 4;
      if (!VALID_BARS.has(ubars)) {
        return NextResponse.json(
          { error_code: 'UPLOAD_INVALID', message: 'loop_length_bars must be 1, 2, 4, or 8' },
          { status: 400 }
        );
      }
      const uStems = Array.isArray(stems) && stems.length ? stems : DEFAULT_STEMS;

      // R9 / PRD §6.1: admission BEFORE the (Replicate-spending) job exists. Uploads
      // bypass YouTube's gate, so this is the primary abuse/spend surface.
      const clientIpHash = clientIpHashOf(request);
      const adm = await checkAdmission(clientIpHash);
      if (!adm.allowed) {
        return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
      }

      await db.query(
        `INSERT INTO jobs (id, input_kind, upload_r2_key, original_filename, requested_stems,
                           loop_length_bars, status, client_ip_hash, client_fingerprint)
         VALUES ($1, 'upload', $2, $3, $4, $5, 'queued', $6, '')`,
        [jobId, uploadKey, typeof filename === 'string' ? filename.slice(0, 255) : null, uStems, ubars, clientIpHash]
      );
      try {
        await enqueueJob(jobId);
      } catch (e) {
        console.error('enqueueJob failed (job still claimable via status):', e);
      }
      return NextResponse.json({ id: jobId, status: 'queued' }, { status: 201 });
    }

    // ── YouTube job (DEFERRED — kept, unwired at the worker until S1 clears) ──
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

    const clientIpHash = clientIpHashOf(request);
    const adm = await checkAdmission(clientIpHash);
    if (!adm.allowed) {
      return NextResponse.json({ error_code: adm.error_code, message: RATE_LIMIT_MSG }, { status: 429 });
    }

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
