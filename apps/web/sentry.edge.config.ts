// Sentry — edge runtime. Loaded via instrumentation.ts. No-op until SENTRY_DSN is set.
// stem-loops doesn't use edge middleware today, but Next.js's Sentry integration
// expects this file regardless — an empty/no-op init is the documented pattern.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.2,
    environment: process.env.VERCEL_ENV || 'production',
  });
}
