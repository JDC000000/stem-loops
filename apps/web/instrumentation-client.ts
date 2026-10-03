// Sentry — browser/client runtime. Auto-loaded by Next.js (Sentry SDK v9+ convention
// — no manual import needed, unlike server/edge which go through instrumentation.ts).
// No-op until NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from '@sentry/nextjs';
import { beforeSend, beforeSendSpan, beforeSendTransaction, tracesSampler } from './src/lib/sentry-options';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Tracing off + scrubbing: transactions carried cookies, job ids and IPs (security review 2026-10-03).
    tracesSampler,
    sendDefaultPii: false,
    beforeSend,
    beforeSendTransaction,
    beforeSendSpan,
    // Session replay is overkill for a low-traffic portfolio app and burns quota fast.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment: process.env.VERCEL_ENV || 'production',
  });
}
