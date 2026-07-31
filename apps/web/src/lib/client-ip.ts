import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';

// Spoof-resistant client-IP resolution for the admission / rate-limit gates.
//
// SECURITY (review BLOCKER #1): a client can set arbitrary *leftmost* X-Forwarded-For
// entries. A trusted reverse proxy APPENDS the real peer it saw to the END of the chain
// (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`), so the real
// client IP is TRUSTED_PROXY_HOPS entries from the RIGHT — never the left. Taking the
// leftmost entry (the old behaviour) let any client forge a fresh IP per request and
// bypass the per-IP rate limit entirely.
//
// DEPLOYMENT (corrected — hardening review H4). The comment here used to claim the app
// sits behind exactly one bare nginx on a VPS with no CDN. That is not the production
// target: apps/web deploys to Vercel (AGENTS.md "Architecture", .github/workflows/
// deploy.yml), an edge platform, and the hop model has to match Vercel's, not nginx's.
//
// Per Vercel's own request-headers documentation:
//   • x-forwarded-for — "The public IP address of the client that made the request. If
//     you are trying to use Vercel behind a proxy, we currently overwrite the
//     X-Forwarded-For header and do not forward external IPs. This restriction is in
//     place to prevent IP spoofing." So Vercel REPLACES the header with a single value
//     rather than appending to a client-supplied chain.
//   • x-vercel-forwarded-for — "identical to the x-forwarded-for header. However,
//     x-forwarded-for could be overwritten if you're using a proxy on top of Vercel."
//     i.e. this is the more trustworthy of the two.
//   (https://vercel.com/docs/headers/request-headers, read 2026-07-31)
//
// So we prefer x-vercel-forwarded-for when present — on Vercel that is authoritative and
// unspoofable — and otherwise fall back to the rightmost-hop walk, which is still correct
// for an nginx-fronted deployment (the VPS option-b box) with TRUSTED_PROXY_HOPS=1.
//
// UNVERIFIED, needs a human check against the live deployment: nobody has actually
// inspected these headers on the deployed site. Hit an endpoint that echoes
// x-forwarded-for / x-vercel-forwarded-for from prod, once with no XFF and once sending
// a forged `X-Forwarded-For: 1.2.3.4`, and confirm the resolved IP is your real address
// in both cases. If a CDN is ever put in front of Vercel, x-forwarded-for gains an
// untrusted hop and TRUSTED_PROXY_HOPS must be raised to match.
const IP_HASH_KEY = process.env.IP_HASH_KEY ?? 'dev-key';
const TRUSTED_PROXY_HOPS = Math.max(
  1,
  Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 1,
);

/** Rightmost trusted entry of an appended proxy chain, or null if the header is empty. */
function rightmostHop(header: string | null, hops: number): string | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= hops ? parts[parts.length - hops] : null;
}

export function clientIp(request: NextRequest): string {
  // Vercel-set and not overwritable by a proxy layered on top of Vercel; it carries a
  // single IP, so hop-walking it is a no-op that just tolerates an unexpected chain.
  const vercel = rightmostHop(request.headers.get('x-vercel-forwarded-for'), 1);
  if (vercel) return vercel;

  const forwarded = rightmostHop(request.headers.get('x-forwarded-for'), TRUSTED_PROXY_HOPS);
  if (forwarded) return forwarded;

  // Fallback: nginx overwrites X-Real-IP with $remote_addr (unspoofable through the
  // proxy); on Vercel it is another copy of the same client IP. Last resort is a shared
  // sentinel bucket (conservative — never fail open).
  return request.headers.get('x-real-ip')?.trim() || '0.0.0.0';
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(IP_HASH_KEY + ip).digest('hex');
}

export function clientIpHashOf(request: NextRequest): string {
  return hashIp(clientIp(request));
}
