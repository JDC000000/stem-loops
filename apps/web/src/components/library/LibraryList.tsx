'use client';

// The song library list (/history; Phase B, B1). Search, sort and the rows: live songs (a link
// to the player), and EXPIRED songs (migration 043) whose audio is gone: title, "BPM · key",
// "Audio expired", and one action: "Re-make · uses 1 of your songs" for a link (one tap ->
// POST /api/library/remake -> the job page) or "Upload again" for an upload. "Remove" deletes
// an expired row's entry after a confirm.
//
// Brand (brief §1): no lime here (the page has no primary fill: Re-make appears once per row,
// so it is a secondary control); no amber (amber belongs to the play screen); selected =
// #222 + a 2 px #fff edge; pills 22 px; every control >= 44 px.
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatExpiresIn } from '@/lib/retention';
import { Sheet } from '@/components/play/Sheet';
import {
  AUDIO_EXPIRED,
  REMAKE_BUSY_LABEL,
  REMAKE_LABEL,
  REMOVE_NOTE,
  SORT_LABELS,
  UPLOAD_AGAIN_LABEL,
  filterSongs,
  readLastOpened,
  sortSongs,
  stateChip,
  type ListedSong,
  type SortMode,
} from '@/lib/library';

export interface LibraryListDeps {
  remake: (entryId: string) => Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  remove: (entryId: string) => Promise<boolean>;
  go: (href: string) => void;
  lastOpened: () => Record<string, number>;
}

export const browserLibraryDeps: LibraryListDeps = {
  remake: async (entryId) => {
    try {
      const res = await fetch('/api/library/remake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_id: entryId }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && typeof body.id === 'string') return { ok: true, id: body.id };
      return { ok: false, message: body.message ?? 'We could not re-make that song. Please try again.' };
    } catch {
      return { ok: false, message: 'We couldn’t reach stem-loops. Check your connection and try again.' };
    }
  },
  remove: async (entryId) => {
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
      return res.ok;
    } catch {
      return false;
    }
  },
  go: (href) => window.location.assign(href),
  lastOpened: () => {
    try {
      return readLastOpened(window.localStorage);
    } catch {
      return {};
    }
  },
};

const SORTS: readonly SortMode[] = ['recent', 'newest', 'az'];

const secondary: React.CSSProperties = {
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 22,
  border: '1.5px solid var(--border-control)',
  background: 'transparent',
  color: 'var(--text-primary)',
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  textDecoration: 'none',
  boxSizing: 'border-box',
  WebkitTapHighlightColor: 'transparent',
};
const textBtn: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--text-secondary)',
  font: 'inherit',
  fontSize: 14,
  textDecoration: 'underline',
  textUnderlineOffset: 4,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};
const metaLine: React.CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, color: 'var(--text-muted)', fontSize: 13,
};

export function LibraryList({ songs, deps = browserLibraryDeps }: { songs: ListedSong[]; deps?: LibraryListDeps }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [opened, setOpened] = useState<Record<string, number>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ entryId: string; message: string } | null>(null);
  const [confirm, setConfirm] = useState<ListedSong | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => setOpened(deps.lastOpened()), [deps]);

  const shown = useMemo(
    () => sortSongs(filterSongs(songs.filter((s) => !(s.entryId && removed.has(s.entryId))), query), sort, opened),
    [songs, removed, query, sort, opened],
  );

  async function remake(s: ListedSong) {
    if (!s.entryId || busy) return;
    setBusy(s.entryId);
    setRowError(null);
    const r = await deps.remake(s.entryId);
    if (r.ok) {
      deps.go(`/jobs/${r.id}`);
      return;
    }
    setBusy(null);
    setRowError({ entryId: s.entryId, message: r.message });
  }

  async function doRemove() {
    const s = confirm;
    if (!s?.entryId) return;
    setRemoveError(null);
    if (await deps.remove(s.entryId)) {
      setRemoved((prev) => new Set(prev).add(s.entryId as string));
      setConfirm(null);
    } else {
      setRemoveError('We could not remove that song. Please try again.');
    }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }} data-testid="library-tools">
        <label htmlFor="library-search" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          Search your songs
        </label>
        <input
          id="library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Song title"
          autoComplete="off"
          data-testid="library-search"
          style={{
            width: '100%', minHeight: 48, padding: '0 12px', borderRadius: 'var(--radius-md)', fontSize: 16,
            border: '1.5px solid var(--border-control)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', boxSizing: 'border-box',
          }}
        />
        <div role="group" aria-label="Sort songs" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="library-sort">
          {SORTS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={sort === m}
              data-sort={m}
              onClick={() => setSort(m)}
              style={{
                ...secondary,
                fontWeight: sort === m ? 700 : 500,
                background: sort === m ? '#222' : 'transparent',
                border: sort === m ? '2px solid #fff' : '1.5px solid var(--border-control)',
                color: sort === m ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {SORT_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }} role="status" data-testid="library-no-match">
          No songs match “{query.trim()}”.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((s) =>
            s.state === 'expired' ? (
              <ExpiredRow
                key={s.key}
                s={s}
                busy={busy === s.entryId}
                disabled={busy !== null}
                error={rowError?.entryId === s.entryId ? rowError.message : null}
                onRemake={() => remake(s)}
                onRemove={(el) => {
                  opener.current = el;
                  setRemoveError(null);
                  setConfirm(s);
                }}
              />
            ) : (
              <LiveRow key={s.key} s={s} />
            ),
          )}
        </ul>
      )}

      <Sheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        labelledBy="library-remove-title"
        returnFocus={() => opener.current}
        testId="library-remove-sheet"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 4px 8px' }}>
          <h2 id="library-remove-title" style={{ fontSize: 20, margin: 0, overflowWrap: 'anywhere' }}>
            Remove “{confirm?.label}” from your library?
          </h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 14 }}>{REMOVE_NOTE}</p>
          {removeError ? (
            <p role="alert" style={{ color: 'var(--status-failed)', margin: 0, fontSize: 14 }}>
              {removeError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={doRemove}
            data-testid="library-remove-confirm"
            style={{ ...secondary, borderColor: 'var(--status-failed)', color: 'var(--status-failed)' }}
          >
            Remove
          </button>
          <button type="button" data-autofocus onClick={() => setConfirm(null)} style={secondary}>
            Keep it
          </button>
        </div>
      </Sheet>
    </>
  );
}

function LiveRow({ s }: { s: ListedSong }) {
  const chip = stateChip(s.state);
  return (
    <li>
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
        {/* QA A-06: the title gets the row's width (two lines on a phone), with the status,
            BPM · key and the countdown under it. */}
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' }}>
          <span className="jp-row-id" data-testid="song-title" style={{ fontSize: s.source === 'browser' ? 13 : 16 }}>
            {s.label}
          </span>
          {chip || !s.isDemo || s.meta ? (
            <span style={metaLine}>
              {chip ? (
                <span className="jp-chip" data-testid="song-status" data-state={s.state}>
                  {chip}
                </span>
              ) : null}
              {s.meta ? <span data-testid="song-meta">{s.meta}</span> : null}
              {/* A demo song (migration 040) is kept until 2099: no "deleted in ~27,000 days". */}
              {s.isDemo || s.expiresAtMs === null ? null : <span style={{ whiteSpace: 'nowrap' }}>deleted {formatExpiresIn(s.expiresAtMs)}</span>}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

function ExpiredRow({
  s,
  busy,
  disabled,
  error,
  onRemake,
  onRemove,
}: {
  s: ListedSong;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onRemake: () => void;
  onRemove: (el: HTMLElement) => void;
}) {
  return (
    <li data-testid="library-entry" data-entry={s.entryId ?? undefined}>
      <div
        className="jp-row"
        data-source="entry"
        data-state="expired"
        style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px', borderRadius: 'var(--radius-md)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {s.thumbUrl ? <SongThumb url={s.thumbUrl} failed={false} dim /> : null}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' }}>
            <span className="jp-row-id" data-testid="song-title" style={{ fontSize: 16 }}>
              {s.label}
            </span>
            <span style={metaLine}>
              <span className="jp-chip" data-testid="song-status" data-state="expired">
                {AUDIO_EXPIRED}
              </span>
              {s.meta ? <span data-testid="song-meta">{s.meta}</span> : null}
            </span>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {s.isUpload ? (
            <a href="/" style={secondary} data-testid="library-upload-again">
              {UPLOAD_AGAIN_LABEL}
            </a>
          ) : (
            <button
              type="button"
              onClick={onRemake}
              disabled={disabled}
              aria-busy={busy || undefined}
              data-testid="library-remake"
              style={{ ...secondary, opacity: disabled && !busy ? 0.6 : 1, cursor: disabled ? 'progress' : 'pointer' }}
            >
              {busy ? REMAKE_BUSY_LABEL : REMAKE_LABEL}
            </button>
          )}
          <button type="button" onClick={(e) => onRemove(e.currentTarget)} style={textBtn} data-testid="library-remove">
            Remove
          </button>
        </div>
        {error ? (
          <p role="alert" data-testid="library-remake-error" style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 14 }}>
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The row's picture (QA A-06). The video's own thumbnail (P5.1, lib/song-thumb.ts) —
 * a plain <img>: next/image would proxy a third-party image through our server;
 * no-referrer keeps this page's address out of YouTube's logs; alt="" because the
 * title beside it names the song. When the image fails to load, or the song failed,
 * a neutral placeholder of the same size takes its place, never the browser's
 * broken-image icon. An expired song's picture is dimmed (its audio is gone).
 */
function SongThumb({ url, failed, dim = false }: { url: string | null; failed: boolean; dim?: boolean }) {
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
      style={{ ...box, objectFit: 'cover', opacity: dim ? 0.5 : 1 }}
    />
  );
}
