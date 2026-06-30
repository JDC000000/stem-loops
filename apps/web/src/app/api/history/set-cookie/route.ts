import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

export const runtime = 'nodejs';

// Mirror the anonymous history into an HMAC-signed httpOnly cookie (P3-7).
// Tamper-evident: the signature is verified on read; a changed payload is rejected.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const jobIds = body?.jobIds;
  if (!Array.isArray(jobIds)) {
    return NextResponse.json({ ok: false }, { status: 422 });
  }
  const payload = JSON.stringify(jobIds.slice(0, 20));
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
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
