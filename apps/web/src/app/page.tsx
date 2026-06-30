import { SubmitForm } from '@/components/SubmitForm';

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 24,
      }}
    >
      <header style={{ textAlign: 'center', maxWidth: 560 }}>
        <h1 style={{ fontSize: 32, margin: 0, color: 'var(--text-primary)' }}>stem-loops</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>
          Paste a YouTube URL to pull bar-aligned, key/BPM-tagged stem loops into your DAW.
        </p>
        <a href="/history" style={{ fontSize: 14, color: 'var(--accent)' }}>
          Your recent loops →
        </a>
      </header>
      <SubmitForm />
    </main>
  );
}
