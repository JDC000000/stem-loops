export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Stem Loops</h1>
      <p>Paste a YouTube URL to extract stem loops.</p>
      <form action="/api/jobs" method="POST">
        <input
          type="url"
          name="url"
          placeholder="https://www.youtube.com/watch?v=..."
          required
          style={{ width: '100%', padding: '12px', fontSize: 16, marginBottom: 12, boxSizing: 'border-box' }}
        />
        <button type="submit" style={{ padding: '12px 24px', fontSize: 16, cursor: 'pointer' }}>
          Extract Loops
        </button>
      </form>
    </main>
  );
}
