'use client';

import { useState, useEffect } from 'react';
import { getHistoryEntries } from '@/lib/history';
import {
  LIBRARY_NOTE_SIGNED_IN,
  LIBRARY_NOTE_SIGNED_OUT,
  listedSongs,
  type LibraryEntryRow,
  type LibraryRow,
  type ListedSong,
} from '@/lib/library';
import { LibraryList } from '@/components/library/LibraryList';

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'ok'; rows: LibraryRow[]; entries: LibraryEntryRow[]; truncated: boolean }
  | { kind: 'signed_out' }
  | { kind: 'error' };

// Library (P3-7; library 2026-11-15). Slice 2a (design P5.2) renamed the "Job history" label to Library, and #316 to Song library; the URL stays /history.
// Signed in: the account's songs from the database (GET /api/library, owner-scoped on the
// server) — a Pro/Studio subscriber's library outlives the 24 h browser history, and works on
// any device. Plus this browser's anonymous songs. Signed out: this browser's history only.
// Phase B, B1: the library also lists every song whose audio is gone (`entries`, migration
// 043) with Re-make / Upload again / Remove, and has search and sort (components/library).
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
        const body = (await res.json()) as { songs?: LibraryRow[]; entries?: LibraryEntryRow[]; truncated?: boolean };
        setLib({ kind: 'ok', rows: body.songs ?? [], entries: body.entries ?? [], truncated: body.truncated === true });
      } catch {
        if (!ac.signal.aborted) setLib({ kind: 'error' });
      }
    })();
    return () => ac.abort();
  }, []);

  const signedIn = lib.kind === 'ok';
  const songs: ListedSong[] = listedSongs(
    lib.kind === 'ok' ? lib.rows : null,
    browser,
    Date.now(),
    lib.kind === 'ok' ? lib.entries : [],
  );

  return (
    <main style={{ minHeight: 'var(--page-min-h)', padding: 24, maxWidth: 640, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ color: 'var(--text-primary)', fontSize: 'var(--text-2xl)' }}>
        {signedIn ? 'Your song library' : 'Song library'}
      </h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 4 }} data-testid="history-retention-note">
        {signedIn ? LIBRARY_NOTE_SIGNED_IN : LIBRARY_NOTE_SIGNED_OUT}
      </p>
      {signedIn && (
        // Set lists have no nav item of their own (A4: three phone items), so the library links
        // to them. A real link with a 44 px tap target; its focus ring is the global :focus-visible
        // style (styles/stem-color.css).
        <p style={{ margin: '4px 0 0' }}>
          <a
            href="/sets"
            data-testid="history-sets-link"
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: 'var(--touch-min)', padding: '0 2px' }}
          >
            Your set lists →
          </a>
        </p>
      )}
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
        <LibraryList songs={songs} />
      )}
      {lib.kind === 'ok' && lib.truncated && (
        <p style={{ color: 'var(--text-muted)' }}>Showing your newest 500 songs.</p>
      )}
    </main>
  );
}
