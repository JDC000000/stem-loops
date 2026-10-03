// Sentry — edge runtime. Loaded via instrumentation.ts. No-op until SENTRY_DSN is set.
// stem-loops doesn't use edge middleware today, but Next.js's Sentry integration
// expects this file regardless — an empty/no-op init is the documented pattern.
import * as Sentry from '@sentry/nextjs';
import {
  beforeBreadcrumb,
  beforeSend,
  beforeSendSpan,
  beforeSendTransaction,
  tracesSampler,
} from './src/lib/sentry-options';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Tracing off + scrubbing: transactions carried cookies, job ids and IPs (security review 2026-10-03).
    tracesSampler,
    sendDefaultPii: false,
    beforeSend,
    beforeSendTransaction,
    beforeSendSpan,
    beforeBreadcrumb,
    environment: process.env.VERCEL_ENV || 'production',
  });
}
