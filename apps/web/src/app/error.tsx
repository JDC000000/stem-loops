'use client';

// Global error boundary. NEVER renders the raw error or any stack trace (PRD §6.1).
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      <p style={{ color: 'var(--text-primary)', fontSize: 18, margin: 0 }}>
        Something went wrong on our end. We&apos;ve logged it — please try again.
      </p>
      <button
        onClick={reset}
        className="jp-primary"
        style={{
          alignSelf: 'flex-start', minHeight: 48, padding: '0 24px', fontSize: 16, fontWeight: 600,
          border: 'none', borderRadius: 10, cursor: 'pointer',
        }}
      >
        Try again
      </button>
      {/* a way out if trying again fails too (the same back link as the job pages) */}
      <a href="/" className="jp-back" style={{ alignSelf: 'flex-start', fontSize: 'var(--text-md)', textDecoration: 'none' }}>
        ← New track
      </a>
    </main>
  );
}
