import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { RETENTION_SEC } from '@/lib/retention';

export const runtime = 'nodejs';

// Job ids are UUIDs (jobs.id). The browser keeps at most 20 (lib/history.ts MAX);
// MAX_IDS leaves headroom for an older or newer client without letting a caller
// push an unbounded list through the signer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 50;
// How many ids the cookie keeps (unchanged): newest first, as the client sends them.
const STORED_IDS = 20;

// Mirror the anonymous history into an HMAC-signed httpOnly cookie (P3-7).
// Tamper-evident: the signature is verified on read; a changed payload is rejected.
//
// Only `{ jobIds: string[] }` of at most MAX_IDS UUIDs is signed. Anything else
// is 422, the same answer a non-array always got. Before this, any JSON array
// was signed as-is (objects, markup, 100 KB strings), which made the endpoint a
// signing oracle for arbitrary payloads and let one request produce a
// Set-Cookie header over 64 KB (W1 overnight QA, 2026-11-12, P2).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds: unknown = body && typeof body === 'object' ? (body as { jobIds?: unknown }).jobIds : undefined;
  if (
    !Array.isArray(jobIds) ||
    jobIds.length > MAX_IDS ||
    !jobIds.every((id) => typeof id === 'string' && UUID_RE.test(id))
  ) {
    return NextResponse.json({ ok: false }, { status: 422 });
  }
  const payload = JSON.stringify((jobIds as string[]).slice(0, STORED_IDS).map((id) => id.toLowerCase()));
  const sig = createHmac('sha256', process.env.HISTORY_COOKIE_KEY ?? 'dev')
    .update(payload)
    .digest('hex');
  const cookieVal = `${Buffer.from(payload).toString('base64')}.${sig}`;
  const res = NextResponse.json({ ok: true });
  res.cookies.set('sl-history', cookieVal, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: RETENTION_SEC, // jobs are deleted after 24h; the cookie is only a backup of their ids
  });
  return res;
}
