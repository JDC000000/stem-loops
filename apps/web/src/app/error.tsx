'use client';

// Global error boundary. NEVER renders the raw error or any stack trace (PRD §6.1).
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      <p style={{ color: 'var(--text-primary)', fontSize: 18, margin: 0 }}>
        Something went wrong on our end. We&apos;ve logged it — please try again.
      </p>
      <button
        onClick={reset}
        style={{
          minHeight: 48, fontSize: 16, fontWeight: 600, color: 'var(--accent-text)',
          background: 'var(--accent)', border: 'none', borderRadius: 10, cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}
