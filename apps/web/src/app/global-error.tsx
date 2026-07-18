'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

// Root-layout error boundary — the ONE class of error src/app/error.tsx can't catch
// (a crash in the layout itself, above the route segment). Sentry.captureException
// is a no-op if SENTRY_DSN isn't configured, so this is safe to ship either way.
// NEVER renders the raw error or any stack trace (PRD §6.1) — same rule as error.tsx.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body style={{ background: '#0d0d0d', margin: 0 }}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
          <p style={{ color: '#ffffff', fontSize: 18, margin: 0 }}>
            Something went wrong on our end. We&apos;ve logged it — please try again.
          </p>
          <button
            onClick={reset}
            style={{
              minHeight: 48, fontSize: 16, fontWeight: 600, color: '#0d0d0d',
              background: '#a3e635', border: 'none', borderRadius: 10, cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
