import { NextRequest, NextResponse } from 'next/server';
import { randomUUID, createHmac } from 'crypto';
import { JobRequestSchema } from '@stem-loops/types';
import { db } from '@/lib/db';
import { enqueueJob } from '@/lib/queue';
import { checkAdmission } from '@/lib/admission';

// pg + crypto require the Node runtime (not edge).
export const runtime = 'nodejs';

const ALLOWED_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);

const invalidUrl = () =>
  NextResponse.json(
    { error_code: 'DOWNLOAD_INVALID_URL', message: "That doesn't look like a YouTube link." },
    { status: 422 },
  );

/** SSRF guard: only allow known YouTube hosts before any outbound work (P1-29/P2-8). */
function ssrfGuard(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function canonicalizeYouTubeUrl(url: string): { canonical: string; videoId: string } | null {
  try {
    const parsed = new URL(url);
    const videoId =
      parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.searchParams.get('v');
    if (!videoId) return null;
    return { canonical: `https://www.youtube.com/watch?v=${videoId}`, videoId };
  } catch {
    return null;
  }
}

function hashIp(ip: string): string {
  return createHmac('sha256', process.env.IP_HASH_KEY ?? 'dev').update(ip).digest('hex');
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = JobRequestSchema.safeParse(body);
  if (!parsed.success) return invalidUrl();

  const { youtube_url, requested_stems, loop_length_bars } = parsed.data;
  if (!ssrfGuard(youtube_url)) return invalidUrl();

  const canon = canonicalizeYouTubeUrl(youtube_url);
  if (!canon) return invalidUrl();

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
  const ipHash = hashIp(ip);
  const fingerprint = req.headers.get('x-fingerprint') ?? '';

  // Admission control BEFORE any insert/enqueue — rate-limit + in-flight cap + spend ceiling.
  const admission = await checkAdmission(ipHash);
  if (!admission.allowed) {
    return NextResponse.json(
      {
        error_code: admission.error_code,
        message: "We're busy or you've hit the limit — wait a moment and try again.",
      },
      { status: 429 },
    );
  }

  const jobId = randomUUID();
  await db.query(
    `INSERT INTO jobs(id, youtube_url, video_id, requested_stems, loop_length_bars,
                      status, client_ip_hash, client_fingerprint)
     VALUES($1,$2,$3,$4,$5,'queued',$6,$7)`,
    [jobId, canon.canonical, canon.videoId, requested_stems, loop_length_bars, ipHash, fingerprint],
  );

  await enqueueJob(jobId);

  return NextResponse.json({ job: { id: jobId, status: 'queued' } }, { status: 201 });
}
