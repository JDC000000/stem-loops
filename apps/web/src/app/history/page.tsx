'use client';

import { useEffect, useState } from 'react';
import { getHistoryEntries } from '@/lib/history';
import { formatExpiresIn } from '@/lib/retention';
import {
  LIBRARY_NOTE_SIGNED_IN,
  LIBRARY_NOTE_SIGNED_OUT,
  listedSongs,
  type LibraryRow,
  type ListedSong,
} from '@/lib/library';

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'ok'; rows: LibraryRow[]; truncated: boolean }
  | { kind: 'signed_out' }
  | { kind: 'error' };

// Library (P3-7; library 2026-11-15). Slice 2a (design P5.2) renamed the "Job history" label to Library; the URL stays /history.
// Signed in: the account's songs from the database (GET /api/library, owner-scoped on the
// server) — a Pro/Studio subscriber's library outlives the 24 h browser history, and works on
// any device. Plus this browser's anonymous songs. Signed out: this browser's history only.
export default function HistoryPage() {
  const [browser, setBrowser] = useState<{ id: string; at: number }[]>([]);
  const [lib, setLib] = useState<LibraryState>({ kind: 'loading' });

  useEffect(() => {
    setBrowser(getHistoryEntries());
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/library', { cache: 'no-store', signal: ac.signal });
        if (res.status === 401) return setLib({ kind: 'signed_out' });
        if (!res.ok) return setLib({ kind: 'error' });
        const body = (await res.json()) as { songs?: LibraryRow[]; truncated?: boolean };
        setLib({ kind: 'ok', rows: body.songs ?? [], truncated: body.truncated === true });
      } catch {
        if (!ac.signal.aborted) setLib({ kind: 'error' });
      }
    })();
    return () => ac.abort();
  }, []);

  const signedIn = lib.kind === 'ok';
  const songs: ListedSong[] = listedSongs(lib.kind === 'ok' ? lib.rows : null, browser);

  return (
    <main style={{ minHeight: '100dvh', padding: 24, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--text-primary)', fontSize: 'var(--text-2xl)' }}>
        {signedIn ? 'Your library' : 'Library'}
      </h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }} data-testid="history-retention-note">
        {signedIn ? LIBRARY_NOTE_SIGNED_IN : LIBRARY_NOTE_SIGNED_OUT}
      </p>
      {lib.kind === 'error' && (
        <p style={{ color: 'var(--text-muted)' }} role="status">
          We could not load your library just now. This is on our end. Showing the songs on this browser.
        </p>
      )}
      {lib.kind === 'loading' ? null : songs.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No songs yet. <a href="/">Start a new song →</a>
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {songs.map((s) => (
            <li key={s.id}>
              <a
                href={`/jobs/${s.id}`}
                className="jp-row"
                data-source={s.source}
                style={{
                  display: 'flex', minHeight: 48, alignItems: 'center', padding: '0 14px',
                  borderRadius: 'var(--radius-md)', textDecoration: 'none',
                  fontFamily: s.source === 'browser' ? 'var(--font-mono, monospace)' : undefined,
                  fontSize: 13, justifyContent: 'space-between', gap: 12,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  {s.thumbUrl ? (
                    // P5.1: the video's own thumbnail, derived from its link (lib/song-thumb.ts).
                    // A plain <img>: next/image would proxy a third-party image through our
                    // server. no-referrer keeps this page's address out of YouTube's logs, and
                    // alt="" because the title beside it already names the song.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.thumbUrl}
                      alt=""
                      width={64}
                      height={36}
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      data-testid="song-thumb"
                      style={{ flex: 'none', width: 64, height: 36, objectFit: 'cover', borderRadius: 4 }}
                    />
                  ) : null}
                  <span className="jp-row-id" style={{ overflowWrap: 'anywhere' }}>{s.label}</span>
                </span>
                {/* A demo song (migration 040) is kept until 2099: no "deleted in ~27,000 days". */}
                {s.isDemo ? null : (
                  <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    deleted {formatExpiresIn(s.expiresAtMs)}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {lib.kind === 'ok' && lib.truncated && (
        <p style={{ color: 'var(--text-muted)' }}>Showing your newest 500 songs.</p>
      )}
    </main>
  );
}
