// Sentry — Node.js server runtime (API routes, SSR). Loaded via instrumentation.ts.
// No-op until SENTRY_DSN is set — safe to ship before the Sentry project exists.
// Server errors are the ones most worth catching: PRD §6.1 already bans stack traces
// in user-facing responses, so right now a real server exception just vanishes into
// Vercel's function logs with no automatic alerting at all. This closes that gap.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.2,
    environment: process.env.VERCEL_ENV || 'production',
  });
}
