'use client';

// /sets — every set list the visitor can open (#322; Phase B, B2): the code-defined Demo set
// first (signed in or out), then the account's own lists, then "+ New set list".
//
// AC 7 tap count: "+ New set list" (1) opens a sheet whose name is prefilled with the first
// free "Set list N", and "Create" (2) makes it and opens it. The sheet's "Create" is the
// view's one lime action (brand A5); everything else is a secondary control.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from '@/components/play/Sheet';
import { buttonBase, fieldStyle, primaryButton } from '@/lib/ui/form-styles';
import {
  DEMO_SET_ID,
  DEMO_SET_NAME,
  DEMO_SET,
  MAX_SET_LISTS,
  canAddList,
  checkSetListName,
  defaultSetListName,
  setHref,
  type SetListSummary,
} from '@/lib/set-lists';
import styles from './SetLists.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; lists: SetListSummary[] }
  | { kind: 'signed_out' }
  | { kind: 'error' };

const songs = (n: number) => (n === 1 ? '1 song' : `${n} songs`);

export function SetListsIndex() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sheet, setSheet] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const newButton = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/set-lists', { cache: 'no-store', signal });
      if (res.status === 401) return setState({ kind: 'signed_out' });
      if (!res.ok) return setState({ kind: 'error' });
      const body = (await res.json()) as { lists?: SetListSummary[] };
      setState({ kind: 'ok', lists: body.lists ?? [] });
    } catch {
      if (!signal?.aborted) setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const lists = state.kind === 'ok' ? state.lists : [];
  const full = state.kind === 'ok' && !canAddList(lists.length);

  const openSheet = () => {
    setName(defaultSetListName(lists.map((l) => l.name)));
    setFormError(null);
    setSheet(true);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const checked = checkSetListName(name);
    if (!checked.ok) return setFormError(checked.message);
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch('/api/set-lists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: checked.name }),
      });
      const body = (await res.json().catch(() => ({}))) as { list?: SetListSummary; message?: string };
      if (res.status === 201 && body.list) {
        globalThis.location?.assign(setHref(body.list.id));
        return;
      }
      setFormError(body.message ?? 'We could not make that set list. Please try again.');
    } catch {
      setFormError('We could not reach stem-loops. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page} data-testid="sets-index">
      <h1 className={styles.title}>Set lists</h1>
      <p className={styles.note}>Group songs in the order you play them.</p>

      <ul className={styles.list} data-testid="sets-list">
        <li className={styles.row}>
          <a className={styles.rowLink} href={setHref(DEMO_SET_ID)} data-testid="sets-demo">
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{DEMO_SET_NAME}</span>
              <span className={styles.rowMeta}>{songs(DEMO_SET.length)} · read-only</span>
            </span>
          </a>
        </li>
        {lists.map((l) => (
          <li key={l.id} className={styles.row}>
            <a className={styles.rowLink} href={setHref(l.id)} data-testid="sets-row">
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{l.name}</span>
                <span className={styles.rowMeta}>{songs(l.song_count)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>

      {state.kind === 'loading' ? null : state.kind === 'signed_out' ? (
        <p className={styles.status} data-testid="sets-sign-in">
          <a href="/login?return_to=/sets">Sign in</a> to make your own set lists.
        </p>
      ) : state.kind === 'error' ? (
        <p className={styles.error} role="status">
          We could not load your set lists just now. This is on our end.
        </p>
      ) : (
        <>
          {lists.length === 0 ? (
            <p className={styles.status} data-testid="sets-empty">
              No set lists of your own yet.
            </p>
          ) : null}
          {full ? (
            <p className={styles.status}>You have {MAX_SET_LISTS} set lists, the most there can be. Delete one to make room.</p>
          ) : (
            <button ref={newButton} type="button" className={styles.secondary} onClick={openSheet} data-testid="sets-new">
              + New set list
            </button>
          )}
        </>
      )}

      <p className={styles.status}>
        <a href="/history">Song library</a>
      </p>

      <Sheet open={sheet} onClose={() => setSheet(false)} labelledBy="new-set-title" returnFocus={() => newButton.current} testId="sets-new-sheet">
        <form onSubmit={create} className={styles.sheetBody}>
          <div className={styles.sheetHead}>
            <h2 id="new-set-title" className={styles.sheetTitle}>
              New set list
            </h2>
            <button type="button" className={styles.secondary} onClick={() => setSheet(false)}>
              Cancel
            </button>
          </div>
          <label className={styles.label} htmlFor="new-set-name">
            Name
          </label>
          <input
            id="new-set-name"
            data-autofocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            style={fieldStyle}
            autoComplete="off"
            data-testid="sets-new-name"
          />
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
          <button type="submit" disabled={busy} style={{ ...buttonBase, ...primaryButton }} data-testid="sets-create">
            Create
          </button>
        </form>
      </Sheet>
    </main>
  );
}

export default SetListsIndex;
