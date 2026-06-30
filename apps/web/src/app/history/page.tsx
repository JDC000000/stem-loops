'use client';

import { useEffect, useState } from 'react';
import { getHistory } from '@/lib/history';

// Anonymous history page (P3-7) — renders recent jobs from localStorage. No login.
export default function HistoryPage() {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    setIds(getHistory());
  }, []);

  return (
    <main style={{ minHeight: '100dvh', padding: 24, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--text-primary)', fontSize: 26 }}>Your recent loops</h1>
      {ids.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No jobs yet. <a href="/" style={{ color: 'var(--accent)' }}>Extract some loops →</a>
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ids.map((id) => (
            <li key={id}>
              <a
                href={`/jobs/${id}`}
                style={{
                  display: 'flex', minHeight: 48, alignItems: 'center', padding: '0 14px',
                  background: 'var(--bg-card)', border: '1px solid var(--border-default)',
                  borderRadius: 8, color: 'var(--text-secondary)', textDecoration: 'none',
                  fontFamily: 'var(--font-mono, monospace)', fontSize: 13,
                }}
              >
                {id}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
