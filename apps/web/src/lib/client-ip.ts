import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { ipHashKey } from '@/lib/secret-env';

// Spoof-resistant client-IP resolution for the admission / rate-limit gates.
//
// SECURITY (review BLOCKER #1): a client can set arbitrary *leftmost* X-Forwarded-For
// entries. A trusted reverse proxy APPENDS the real peer it saw to the END of the
// chain (nginx here uses `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`),
// so the real client IP is TRUSTED_PROXY_HOPS entries from the RIGHT — never the left.
// Taking the leftmost entry (the old behaviour) let any client forge a fresh IP per
// request and bypass the per-IP rate limit entirely.
//
// Deployment: production and staging run on Vercel (live responses say `server: Vercel`).
// Vercel OVERWRITES X-Forwarded-For with the client address it saw and does not forward an
// external client's value (https://vercel.com/docs/edge-network/headers/request-headers), so
// the default of 1 hop takes the rightmost entry, which is that address. An earlier comment
// here described a single nginx on a VPS; that deployment no longer exists. If another proxy
// or CDN is ever put in front of Vercel, set TRUSTED_PROXY_HOPS to match. (QA track B, B-13.)
// IP_HASH_KEY: read per call through lib/secret-env.ts, which throws in production when it is
// unset (QA track B, B-08). It used to fall back to the public 'dev-key'.
const TRUSTED_PROXY_HOPS = Math.max(
  1,
  Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 1,
);

export function clientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= TRUSTED_PROXY_HOPS) {
      return parts[parts.length - TRUSTED_PROXY_HOPS];
    }
  }
  // Fallback: nginx overwrites X-Real-IP with $remote_addr (unspoofable through the
  // proxy). Last resort is a shared sentinel bucket (conservative — never fail open).
  return request.headers.get('x-real-ip')?.trim() || '0.0.0.0';
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ipHashKey() + ip).digest('hex');
}

export function clientIpHashOf(request: NextRequest): string {
  return hashIp(clientIp(request));
}
