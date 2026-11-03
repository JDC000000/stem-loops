// Next.js instrumentation hook (stable since Next 14) — Sentry's documented entry
// point for server + edge runtime init. No-op end-to-end until SENTRY_DSN is set
// (see ../sentry.server.config.ts / ../sentry.edge.config.ts).
//
// SL-B10a (2026-11-03): moved from apps/web/instrumentation.ts into src/ because
// this app uses the src/app layout, and Next.js 14 only reads src/instrumentation.ts
// when src/ exists. The file at apps/web/instrumentation.ts was dead code and
// Sentry server/edge was never initialising — see handoff ledger SL-B10 (a).
// The sentry.server.config.ts / sentry.edge.config.ts files intentionally stay
// at apps/web root (that's where @sentry/nextjs's build-time integration and
// the sentry-guard test both expect them); only this loader moved.
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
