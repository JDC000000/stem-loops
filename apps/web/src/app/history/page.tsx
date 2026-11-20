'use client';

import { useState, useEffect } from 'react';
import { getHistoryEntries } from '@/lib/history';
import { formatExpiresIn } from '@/lib/retention';
import {
  LIBRARY_NOTE_SIGNED_IN,
  LIBRARY_NOTE_SIGNED_OUT,
  listedSongs,
  stateChip,
  type LibraryRow,
  type ListedSong,
} from '@/lib/library';

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'ok'; rows: LibraryRow[]; truncated: boolean }
  | { kind: 'signed_out' }
  | { kind: 'error' };

// Library (P3-7; library 2026-11-15). Slice 2a (design P5.2) renamed the "Job history" label to Library, and #316 to Song library; the URL stays /history.
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
        {signedIn ? 'Your song library' : 'Song library'}
      </h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }} data-testid="history-retention-note">
        {signedIn ? LIBRARY_NOTE_SIGNED_IN : LIBRARY_NOTE_SIGNED_OUT}
      </p>
      {lib.kind === 'error' && (
        <p style={{ color: 'var(--text-muted)' }} role="status">
          We could not load your library just now. This is on our end. Showing the songs on this browser.
        </p>
      )}
      {lib.kind === 'loading' ? null : songs.length === 0 && lib.kind === 'signed_out' ? (
        // QA A-14: signed out on a new device, "No songs yet" read as a lost library.
        <p style={{ color: 'var(--text-muted)' }} data-testid="history-sign-in">
          Sign in to see your library.{' '}
          {/* A >= 24px tap target (review of #301, F-5), still inline in the sentence. */}
          <a href="/login?return_to=/history" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 24, padding: '0 2px' }}>
            Sign in →
          </a>
        </p>
      ) : songs.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No songs yet. <a href="/">Start a new song →</a>
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {songs.map((s) => {
            const chip = stateChip(s.state);
            return (
              <li key={s.id}>
                <a
                  href={`/jobs/${s.id}`}
                  className="jp-row"
                  data-source={s.source}
                  data-state={s.state}
                  style={{
                    display: 'flex', minHeight: 48, alignItems: 'center', padding: '8px 14px',
                    borderRadius: 'var(--radius-md)', textDecoration: 'none',
                    fontFamily: s.source === 'browser' ? 'var(--font-mono, monospace)' : undefined,
                    fontSize: 13, gap: 12,
                  }}
                >
                  {s.thumbUrl || s.state === 'failed' ? <SongThumb url={s.thumbUrl} failed={s.state === 'failed'} /> : null}
                  {/* QA A-06: the title gets the row's width (two lines on a phone, it was
                      cut to ~13 characters), with the status and the countdown under it. */}
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' }}>
                    <span className="jp-row-id" data-testid="song-title">{s.label}</span>
                    {chip || !s.isDemo ? (
                      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                        {chip ? (
                          <span className="jp-chip" data-testid="song-status" data-state={s.state}>
                            {chip}
                          </span>
                        ) : null}
                        {/* A demo song (migration 040) is kept until 2099: no "deleted in ~27,000 days". */}
                        {s.isDemo ? null : <span style={{ whiteSpace: 'nowrap' }}>deleted {formatExpiresIn(s.expiresAtMs)}</span>}
                      </span>
                    ) : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {lib.kind === 'ok' && lib.truncated && (
        <p style={{ color: 'var(--text-muted)' }}>Showing your newest 500 songs.</p>
      )}
    </main>
  );
}

/**
 * The row's picture (QA A-06). The video's own thumbnail (P5.1, lib/song-thumb.ts) —
 * a plain <img>: next/image would proxy a third-party image through our server;
 * no-referrer keeps this page's address out of YouTube's logs; alt="" because the
 * title beside it names the song. When the image fails to load, or the song failed,
 * a neutral placeholder of the same size takes its place, never the browser's
 * broken-image icon.
 */
function SongThumb({ url, failed }: { url: string | null; failed: boolean }) {
  const [broken, setBroken] = useState(false);
  const box: React.CSSProperties = { flex: 'none', width: 64, height: 36, borderRadius: 4 };
  if (!url || broken || failed) {
    return (
      <span
        aria-hidden="true"
        data-testid="song-thumb-placeholder"
        className="jp-thumb-empty"
        style={{ ...box, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {failed ? '!' : null}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={64}
      height={36}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      data-testid="song-thumb"
      onError={() => setBroken(true)}
      style={{ ...box, objectFit: 'cover' }}
    />
  );
}
