/**
 * Browser-side report of a play-along stem fetch that failed for a reason only
 * the browser can see.
 *
 * WHY THIS EXISTS. Everything else that can go wrong on the way to playback is
 * visible server-side: the stems route reports a failed R2 list, the worker
 * reports a failed encode. What nothing server-side can see is the browser
 * failing to GET a presigned R2 URL — a missing CORS rule on the bucket for the
 * serving origin, a CSP `connect-src` miss, DNS. From the browser those all
 * surface as `fetch` rejecting with a TypeError and no response, and before this
 * they surfaced as nothing: the player fell through to its "no stems" note and
 * nobody was told. If the bucket's CORS is wrong, that is EVERY user.
 *
 * NO NEW DEPENDENCY, NO NEW CONFIG. This uses `@sentry/nextjs`, already a
 * dependency, through the client init in `instrumentation-client.ts`, which is a
 * no-op until `NEXT_PUBLIC_SENTRY_DSN` is set. Whether production sets it is not
 * knowable from the repo. The `console.error` below is the fallback that exists
 * either way.
 *
 * WHAT IS SENT. Counts, status codes, and URL ORIGINS (scheme + host), plus the
 * page's own origin — the value an owner needs to compare against the bucket's
 * CORS allow-list. Never a URL path or query: a stem URL carries a presigned
 * signature. Never the job id.
 *
 * VOLUME. One event per page load at most (module flag) under ONE fixed
 * fingerprint per reason, so an outage collapses into one issue whose counter
 * rises rather than one issue per user. This is the same posture the stems route
 * documents for its own Sentry capture. `encode_failed` is deliberately NOT sent
 * from here: the worker already reports it once per job, and a refetch of a
 * broken job by anyone holding the UUID would otherwise mint events at will.
 */
import * as Sentry from '@sentry/nextjs';

import type { StemFailureSummary } from './load-stems.ts';

export type StemFetchReason = 'FETCH_NETWORK' | 'FETCH_HTTP' | 'FETCH_BODY';

let reported = false;

function pageOrigin(): string | null {
  try {
    return globalThis.location?.origin ?? null;
  } catch {
    return null;
  }
}

export function reportStemFetchFailure(reason: StemFetchReason, f: StemFailureSummary): void {
  if (reported) return;
  reported = true;
  const extra = {
    reason,
    listed: f.listed,
    network: f.network,
    http: f.http,
    httpStatuses: [...f.httpStatuses],
    body: f.body,
    storageOrigins: [...f.storageOrigins],
    pageOrigin: pageOrigin(),
  };
  console.error(`play-along: stem fetch failed (${reason})`, JSON.stringify(extra));
  try {
    Sentry.captureMessage(`play-along: stem fetch failed (${reason})`, {
      level: 'error',
      fingerprint: ['play-along', 'STEM_FETCH', reason],
      extra,
    });
  } catch {
    // Telemetry must never break the page.
  }
}
