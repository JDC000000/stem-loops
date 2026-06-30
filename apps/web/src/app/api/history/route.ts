import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';

// Read the HMAC-signed history cookie and return its job ids (P3-7).
// A tampered cookie fails the signature check and is rejected (empty history) —
// never trusted blindly. The UI's primary source is still localStorage.
export async function GET(req: NextRequest) {
  const raw = req.cookies.get('sl-history')?.value;
  if (!raw || !raw.includes('.')) return NextResponse.json({ jobIds: [] });

  const [b64, sig] = raw.split('.');
  let payload: string;
  try {
    payload = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return NextResponse.json({ jobIds: [], tampered: true }, { status: 200 });
  }
  const expected = createHmac('sha256', process.env.HISTORY_COOKIE_KEY ?? 'dev')
    .update(payload)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && timingSafeEqual(a, b);
  if (!valid) return NextResponse.json({ jobIds: [], tampered: true }, { status: 200 });

  try {
    return NextResponse.json({ jobIds: JSON.parse(payload) });
  } catch {
    return NextResponse.json({ jobIds: [] });
  }
}
