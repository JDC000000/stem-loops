'use client';

// /sets/[id] — one set list (#322; Phase B, B2). The Demo set (`demo`) is read-only and works
// signed out; an account's own list can be renamed, reordered (Move up / Move down, 44px and
// keyboard-operable buttons, AC 8), have songs taken out, and be deleted (confirm, and the
// plain sentence that deleting a list never deletes songs, AC 3).
//
// Each playable row opens the player with ?set=<id>, which is what shows "Next song ›".
// A row whose song cannot play says why: "Audio expired" (a link: paste it again and the row
// plays the new one), "Unavailable" (an upload or a demo song that is gone), "Processing".
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from '@/components/play/Sheet';
import { buttonBase, fieldStyle, primaryButton } from '@/lib/ui/form-styles';
import {
  DELETE_LIST_NOTE,
  DEMO_SET_ID,
  checkSetListName,
  itemStateLabel,
  moveItem,
  playHref,
  type SetListDetail,
  type SetListItem,
} from '@/lib/set-lists';
import styles from './SetLists.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; list: SetListDetail }
  | { kind: 'not_found' }
  | { kind: 'signed_out' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'error' };

export interface SetListViewProps {
  readonly id: string;
}

export function SetListView({ id }: SetListViewProps) {
  const isDemo = id === DEMO_SET_ID;
  const api = isDemo ? '/api/set-lists/demo' : `/api/set-lists/${encodeURIComponent(id)}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const renameButton = useRef<HTMLButtonElement | null>(null);
  /** After a move, focus stays on the same song's button in its new place. */
  const refocus = useRef<{ item: string; dir: 'up' | 'down' } | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(api, { cache: 'no-store', signal });
        if (res.status === 401) return setState({ kind: 'signed_out' });
        if (res.status === 404) return setState({ kind: 'not_found' });
        if (res.status === 429) {
          const b = (await res.json().catch(() => ({}))) as { message?: string };
          return setState({ kind: 'rate_limited', message: b.message ?? 'Too many requests. Wait a minute and try again.' });
        }
        if (!res.ok) return setState({ kind: 'error' });
        const body = (await res.json()) as { list: SetListDetail };
        setState({ kind: 'ok', list: body.list });
      } catch {
        if (!signal?.aborted) setState({ kind: 'error' });
      }
    },
    [api],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    const doc = globalThis.document;
    const el =
      doc?.querySelector<HTMLButtonElement>(`[data-item="${r.item}"] [data-move="${r.dir}"]:not(:disabled)`) ??
      doc?.querySelector<HTMLButtonElement>(`[data-item="${r.item}"] [data-move]:not(:disabled)`);
    el?.focus();
  });

  const list = state.kind === 'ok' ? state.list : null;
  const editable = !!list && !list.is_demo;

  const write = async (url: string, method: string, body?: unknown): Promise<Response | null> => {
    try {
      return await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      setNotice('We could not reach stem-loops. Check your connection and try again.');
      return null;
    }
  };

  const move = async (i: number, dir: 'up' | 'down') => {
    if (!list || busy) return;
    const order = moveItem(list.items, i, dir === 'up' ? -1 : 1);
    const item = list.items[i];
    // Optimistic: the list moves at once; a refusal reloads it as the server has it.
    setState({ kind: 'ok', list: { ...list, items: order.map((it, position) => ({ ...it, position })) } });
    refocus.current = { item: item.item_id, dir };
    setBusy(true);
    const res = await write(`${api}/songs`, 'PUT', { order: order.map((it) => it.item_id) });
    setBusy(false);
    if (!res?.ok) {
      const b = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
      if (res) setNotice(b?.message ?? 'We could not move that song. Please try again.');
      await load();
    } else {
      setNotice(`Moved ${item.title} ${dir}.`);
    }
  };

  const remove = async (it: SetListItem) => {
    if (!list || busy) return;
    setBusy(true);
    const res = await write(`${api}/songs`, 'DELETE', { item_id: it.item_id });
    setBusy(false);
    if (res?.ok) setNotice(`Took ${it.title} out of this list. The song is still in your library.`);
    else if (res) setNotice('We could not take that song out. Please try again.');
    await load();
  };

  const doDelete = async () => {
    setBusy(true);
    const res = await write(api, 'DELETE');
    setBusy(false);
    if (res && (res.status === 204 || res.ok)) {
      globalThis.location?.assign('/sets');
      return;
    }
    setConfirm(false);
    if (res) setNotice('We could not delete that set list. Please try again.');
  };

  const doRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const checked = checkSetListName(name);
    if (!checked.ok) return setFormError(checked.message);
    setBusy(true);
    const res = await write(api, 'PATCH', { name: checked.name });
    setBusy(false);
    if (res?.ok && list) {
      setState({ kind: 'ok', list: { ...list, name: checked.name } });
      setRename(false);
      return;
    }
    const b = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
    setFormError(b?.message ?? 'We could not rename that set list. Please try again.');
  };

  if (state.kind !== 'ok' || !list) {
    return (
      <main className={styles.page} data-testid="set-view" data-state={state.kind}>
        <p className={styles.status}>
          <a href="/sets">‹ Set lists</a>
        </p>
        {state.kind === 'loading' ? null : state.kind === 'signed_out' ? (
          <p className={styles.status}>
            <a href={`/login?return_to=/sets/${encodeURIComponent(id)}`}>Sign in</a> to see this set list.
          </p>
        ) : state.kind === 'not_found' ? (
          <p className={styles.status}>We couldn’t find that set list.</p>
        ) : state.kind === 'rate_limited' ? (
          <p className={styles.error} role="status">
            {state.message}
          </p>
        ) : (
          <p className={styles.error} role="status">
            We could not load this set list just now. This is on our end.
          </p>
        )}
      </main>
    );
  }

  return (
    <main className={styles.page} data-testid="set-view" data-state="ok" data-demo={list.is_demo ? 'true' : 'false'}>
      <p className={styles.status} style={{ margin: 0 }}>
        <a href="/sets">‹ Set lists</a>
      </p>
      <div className={styles.head}>
        <h1 className={styles.title} data-testid="set-name">
          {list.name}
        </h1>
        {editable ? (
          <button
            ref={renameButton}
            type="button"
            className={styles.secondary}
            onClick={() => {
              setName(list.name);
              setFormError(null);
              setRename(true);
            }}
          >
            Rename
          </button>
        ) : null}
      </div>
      {list.is_demo ? <p className={styles.note}>Three songs to try. This set can’t be changed.</p> : null}
      <p className={styles.status} role="status" aria-live="polite" data-testid="set-notice">
        {notice ?? ''}
      </p>

      {list.items.length === 0 ? (
        <p className={styles.status} data-testid="set-empty">
          No songs yet. Open a song and choose ⋯ then “Add to set list…”.
        </p>
      ) : (
        <ol className={styles.list} data-testid="set-items">
          {list.items.map((it, i) => {
            const label = itemStateLabel(it.state);
            const playable = it.state === 'ready' && !!it.job_id;
            const body = (
              <>
                <span className={styles.pos} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.rowText}>
                  <span className={`${styles.rowTitle} ${playable ? '' : styles.dim}`}>{it.title}</span>
                  {label ? (
                    <span className={styles.chip} data-testid="set-item-state" data-state={it.state}>
                      {label}
                    </span>
                  ) : null}
                </span>
              </>
            );
            return (
              <li key={it.item_id} className={styles.row} data-item={it.item_id} data-testid="set-item" data-state={it.state}>
                {playable ? (
                  <a className={styles.rowLink} href={playHref(it.job_id as string, list.id)}>
                    {body}
                  </a>
                ) : (
                  <span className={styles.rowLink}>{body}</span>
                )}
                {editable ? (
                  <>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      data-move="up"
                      aria-label={`Move ${it.title} up`}
                      disabled={i === 0}
                      onClick={() => move(i, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      data-move="down"
                      aria-label={`Move ${it.title} down`}
                      disabled={i === list.items.length - 1}
                      onClick={() => move(i, 'down')}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Take ${it.title} out of this list`}
                      disabled={busy}
                      onClick={() => remove(it)}
                    >
                      ×
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {editable ? (
        <div className={styles.actions}>
          <button ref={deleteButton} type="button" className={styles.danger} onClick={() => setConfirm(true)} data-testid="set-delete">
            Delete list
          </button>
        </div>
      ) : null}
      {editable ? <p className={styles.status}>{DELETE_LIST_NOTE}</p> : null}

      <Sheet open={confirm} onClose={() => setConfirm(false)} labelledBy="delete-set-title" returnFocus={() => deleteButton.current} testId="set-delete-sheet">
        <div className={styles.sheetBody}>
          <h2 id="delete-set-title" className={styles.sheetTitle}>
            Delete “{list.name}”?
          </h2>
          <p className={styles.note} style={{ margin: 0 }}>
            {DELETE_LIST_NOTE} Every song stays in your song library.
          </p>
          <button type="button" className={styles.danger} disabled={busy} onClick={doDelete} data-testid="set-delete-confirm">
            Delete list
          </button>
          <button type="button" className={styles.secondary} data-autofocus onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      </Sheet>

      <Sheet open={rename} onClose={() => setRename(false)} labelledBy="rename-set-title" returnFocus={() => renameButton.current} testId="set-rename-sheet">
        <form className={styles.sheetBody} onSubmit={doRename}>
          <h2 id="rename-set-title" className={styles.sheetTitle}>
            Rename set list
          </h2>
          <label className={styles.label} htmlFor="rename-set-name">
            Name
          </label>
          <input id="rename-set-name" data-autofocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={fieldStyle} autoComplete="off" />
          {formError ? (
            <p className={styles.error} role="alert">
              {formError}
            </p>
          ) : null}
          <button type="submit" disabled={busy} style={{ ...buttonBase, ...primaryButton }}>
            Save
          </button>
        </form>
      </Sheet>
    </main>
  );
}

export default SetListView;
