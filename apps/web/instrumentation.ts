// Next.js instrumentation hook (stable since Next 14) — Sentry's documented entry
// point for server + edge runtime init. No-op end-to-end until SENTRY_DSN is set
// (see sentry.server.config.ts / sentry.edge.config.ts).
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
