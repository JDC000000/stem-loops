// The per-IP limit on demo-song READS (design v1.5 P3.1 "Abuse limits"). Applied by
// GET /api/jobs/:id and GET /api/jobs/:id/play-chords ONLY when the row is a demo, after
// the lookup that tells them so; ordinary jobs never reach it, so their behaviour is
// unchanged. GET /api/jobs/:id/stems needs no extra call: its existing limiter
// (checkStemListRate) already runs first, for every job, demos included.
//
// Read-only (lib/admission.ts peekStemListRate): it never writes on GET.
import type { NextRequest } from 'next/server';
import { peekStemListRate } from '@/lib/admission';
import { clientIpHashOf } from '@/lib/client-ip';

/** The same words and code the stems route answers a throttled caller with. */
export const DEMO_RATE_LIMIT_MSG = "You're sending requests too fast. Wait a minute and try again.";

/** True when this IP may make another demo read now. Throws on a DB fault (fails closed). */
export async function demoReadAllowed(request: NextRequest): Promise<boolean> {
  const r = await peekStemListRate(clientIpHashOf(request));
  return r.allowed;
}
