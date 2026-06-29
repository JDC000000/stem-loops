'use client';

import { useState } from 'react';
import { JobRequestSchema, STEMS } from '@stem-loops/types';

const BAR_OPTIONS = [1, 2, 4, 8] as const;
type Bars = (typeof BAR_OPTIONS)[number];

export function SubmitForm() {
  const [url, setUrl] = useState('');
  const [stems, setStems] = useState<string[]>([...STEMS]);
  const [bars, setBars] = useState<Bars>(4);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggleStem(stem: string) {
    setStems((prev) => (prev.includes(stem) ? prev.filter((s) => s !== stem) : [...prev, stem]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = JobRequestSchema.safeParse({
      youtube_url: url.trim(),
      requested_stems: stems,
      loop_length_bars: bars,
    });
    if (!parsed.success) {
      const onStems = parsed.error.issues.some((i) => i.path[0] === 'requested_stems');
      setError(
        onStems
          ? 'Pick at least one stem to extract.'
          : "That doesn't look like a YouTube link. Paste a full youtube.com or youtu.be URL.",
      );
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }
      window.location.href = `/jobs/${data.job.id}`;
    } catch {
      setError('Network error. Please check your connection and try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={styles.form} noValidate>
      <input
        type="url"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a YouTube URL"
        aria-label="YouTube URL"
        style={styles.input}
      />

      <fieldset style={styles.fieldset}>
        <legend style={styles.legend}>Stems</legend>
        <div style={styles.stemGrid}>
          {STEMS.map((stem) => (
            <label key={stem} style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={stems.includes(stem)}
                onChange={() => toggleStem(stem)}
                style={styles.checkbox}
              />
              {stem}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset style={styles.fieldset}>
        <legend style={styles.legend}>Loop length</legend>
        <div style={styles.barRow}>
          {BAR_OPTIONS.map((b) => (
            <label key={b} style={{ ...styles.barLabel, ...(bars === b ? styles.barLabelActive : {}) }}>
              <input
                type="radio"
                name="bars"
                checked={bars === b}
                onChange={() => setBars(b)}
                style={styles.srOnly}
              />
              {b} {b === 1 ? 'bar' : 'bars'}
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}

      <button type="submit" disabled={loading} style={styles.submit}>
        {loading ? 'Submitting…' : 'Extract Loops'}
      </button>
    </form>
  );
}

// Inline styles keyed off design-tokens.css CSS vars. Mobile-first: full-width
// controls, ≥44px touch targets, no horizontal scroll at 375px.
const styles: Record<string, React.CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: 560 },
  input: {
    width: '100%', minHeight: 48, padding: '0 16px', fontSize: 16,
    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border-default)', borderRadius: 10, boxSizing: 'border-box',
  },
  fieldset: { border: 'none', padding: 0, margin: 0 },
  legend: { fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, padding: 0 },
  stemGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 },
  checkLabel: {
    display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 12px',
    background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 8,
    color: 'var(--text-secondary)', textTransform: 'capitalize', cursor: 'pointer', fontSize: 15,
  },
  checkbox: { width: 18, height: 18, accentColor: 'var(--accent)' },
  barRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  barLabel: {
    flex: '1 1 64px', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 8,
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 15,
  },
  barLabelActive: { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-muted)' },
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' },
  error: { color: 'var(--status-failed)', fontSize: 14, margin: 0 },
  submit: {
    minHeight: 52, fontSize: 16, fontWeight: 700, color: 'var(--accent-text)',
    background: 'var(--accent)', border: 'none', borderRadius: 10, cursor: 'pointer',
  },
};
