import { NextRequest, NextResponse } from 'next/server';
import { readHistoryCookie } from '@/lib/history-cookie';

export const runtime = 'nodejs';

// Read the HMAC-signed history cookie and return its job ids (P3-7).
// A tampered cookie fails the signature check and is rejected (empty history) —
// never trusted blindly. The UI's primary source is still localStorage.
//
// The verification itself lives in @/lib/history-cookie so that this route and
// the signed-in nav (which turns the newest id into its "Play along" href)
// cannot drift apart. The response body is byte-for-byte what it was: the
// verifier returns the same `tampered` flag the inline block set, and both
// shapes still come back as status 200.
export async function GET(req: NextRequest) {
  return NextResponse.json(readHistoryCookie(req.cookies.get('sl-history')?.value));
}
