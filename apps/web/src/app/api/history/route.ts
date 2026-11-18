import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { historyCookieKey } from '@/lib/secret-env';

export const runtime = 'nodejs';

// Read the HMAC-signed history cookie and return its job ids (P3-7).
// A tampered cookie fails the signature check and is rejected (empty history) —
// never trusted blindly. The UI's primary source is still localStorage.
// QA track B, B-10: the body depends on the caller's cookie, so no shared cache may keep it.
// Next's default for a route response is `public, max-age=0, must-revalidate`.
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(req: NextRequest) {
  const raw = req.cookies.get('sl-history')?.value;
  if (!raw || !raw.includes('.')) return NextResponse.json({ jobIds: [] }, { headers: NO_STORE });

  const [b64, sig] = raw.split('.');
  let payload: string;
  try {
    payload = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return NextResponse.json({ jobIds: [], tampered: true }, { status: 200, headers: NO_STORE });
  }
  const expected = createHmac('sha256', historyCookieKey())
    .update(payload)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && timingSafeEqual(a, b);
  if (!valid) return NextResponse.json({ jobIds: [], tampered: true }, { status: 200, headers: NO_STORE });

  try {
    return NextResponse.json({ jobIds: JSON.parse(payload) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ jobIds: [] }, { headers: NO_STORE });
  }
}
