// Sentry — browser/client runtime. Auto-loaded by Next.js (Sentry SDK v9+ convention
// — no manual import needed, unlike server/edge which go through instrumentation.ts).
// No-op until NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.2,
    // Session replay is overkill for a low-traffic portfolio app and burns quota fast.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment: process.env.VERCEL_ENV || 'production',
  });
}
