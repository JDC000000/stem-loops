'use client';

// The player's set-list actions (#322; Phase B, B2), in the ⋯ menu:
//
//   "Add to <last-used list>"  one tap with the menu open (AC 7). The last-used list is the
//                              most recently changed one (GET /api/set-lists orders by it).
//   "Add to set list…"         opens a checklist of every list (a song may be in several;
//                              ticking adds, unticking takes it out) with "New set list"
//                              inline.
//
// Signed out, the checklist says to sign in (set lists belong to an account). Nothing here is
// plan-gated: Free, Pro and Studio alike. No lime: the player's one lime fill is Play.
import { useCallback, useEffect, useState } from 'react';
import { Sheet } from '@/components/play/Sheet';
import { fieldStyle } from '@/lib/ui/form-styles';
import { canAddList, checkSetListName, defaultSetListName, type SetListSummary } from '@/lib/set-lists';
import styles from './SetLists.module.css';

type Lists = { kind: 'loading' } | { kind: 'ok'; lists: SetListSummary[] } | { kind: 'signed_out' } | { kind: 'error' };

/** GET /api/set-lists?job=<id>, re-readable. */
function useSetLists(jobId: string, active: boolean) {
  const [state, setState] = useState<Lists>({ kind: 'loading' });
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/set-lists?job=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (res.status === 401) return setState({ kind: 'signed_out' });
      if (!res.ok) return setState({ kind: 'error' });
      const body = (await res.json()) as { lists?: SetListSummary[] };
      setState({ kind: 'ok', lists: body.lists ?? [] });
    } catch {
      setState({ kind: 'error' });
    }
  }, [jobId]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  return { state, load };
}

async function addTo(listId: string, jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/set-lists/${encodeURIComponent(listId)}/songs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function takeOut(listId: string, jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/set-lists/${encodeURIComponent(listId)}/songs`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SetListMenuItemsProps {
  readonly jobId: string;
  readonly itemClassName: string;
  /** Close the ⋯ menu. */
  readonly onClose: () => void;
  /** Open the checklist sheet. */
  readonly onOpenPicker: () => void;
  /** A one-line result for the player to show ("Added to JAMS."). */
  readonly onMessage: (text: string) => void;
}

/** The ⋯ menu entries. Mounted only while the menu is open, so the lists are read then. */
export function SetListMenuItems({ jobId, itemClassName, onClose, onOpenPicker, onMessage }: SetListMenuItemsProps) {
  const { state } = useSetLists(jobId, true);
  const last = state.kind === 'ok' ? (state.lists[0] ?? null) : null;
  return (
    <>
      {last ? (
        <button
          type="button"
          className={itemClassName}
          data-testid="player-add-last"
          disabled={last.has_job === true}
          aria-disabled={last.has_job === true}
          onClick={async () => {
            onClose();
            onMessage((await addTo(last.id, jobId)) ? `Added to ${last.name}.` : `Could not add to ${last.name}. Try again.`);
          }}
        >
          {last.has_job ? `In ${last.name}` : `Add to ${last.name}`}
        </button>
      ) : null}
      <button
        type="button"
        className={itemClassName}
        data-testid="player-add-to-set"
        onClick={() => {
          onClose();
          onOpenPicker();
        }}
      >
        Add to set list…
      </button>
    </>
  );
}

export interface SetListPickerProps {
  readonly jobId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocus?: () => HTMLElement | null;
  readonly onMessage: (text: string) => void;
}

/** The checklist sheet: one row per list, ticked when the song is in it, plus a new list. */
export function SetListPicker({ jobId, open, onClose, returnFocus, onMessage }: SetListPickerProps) {
  const { state, load } = useSetLists(jobId, open);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lists = state.kind === 'ok' ? state.lists : [];

  useEffect(() => {
    if (open && state.kind === 'ok') setName(defaultSetListName(state.lists.map((l) => l.name)));
    // Prefill once per open, not on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.kind]);

  const toggle = async (l: SetListSummary) => {
    setBusy(l.id);
    const ok = l.has_job ? await takeOut(l.id, jobId) : await addTo(l.id, jobId);
    setBusy(null);
    onMessage(ok ? (l.has_job ? `Taken out of ${l.name}.` : `Added to ${l.name}.`) : 'That did not work. Try again.');
    await load();
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const checked = checkSetListName(name);
    if (!checked.ok) return setError(checked.message);
    setBusy('new');
    setError(null);
    try {
      const res = await fetch('/api/set-lists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: checked.name }),
      });
      const body = (await res.json().catch(() => ({}))) as { list?: SetListSummary; message?: string };
      if (res.status === 201 && body.list) {
        const ok = await addTo(body.list.id, jobId);
        onMessage(ok ? `Added to ${body.list.name}.` : `Made ${body.list.name}, but could not add the song. Try again.`);
        await load();
      } else {
        setError(body.message ?? 'We could not make that set list. Please try again.');
      }
    } catch {
      setError('We could not reach stem-loops. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  const here = typeof globalThis.location?.pathname === 'string' ? globalThis.location.pathname : '/';

  return (
    <Sheet open={open} onClose={onClose} labelledBy="add-set-title" returnFocus={returnFocus} testId="add-set-sheet">
      <div className={styles.sheetHead}>
        <h2 id="add-set-title" className={styles.sheetTitle}>
          Add to set list
        </h2>
        <button type="button" className={styles.secondary} onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
      <div className={styles.sheetBody}>
        {state.kind === 'loading' ? (
          <p className={styles.status}>Loading your set lists…</p>
        ) : state.kind === 'signed_out' ? (
          <p className={styles.status} data-testid="add-set-sign-in">
            Set lists belong to an account. <a href={`/login?return_to=${encodeURIComponent(here)}`}>Sign in</a> to make one.
          </p>
        ) : state.kind === 'error' ? (
          <p className={styles.error} role="status">
            We could not load your set lists just now. This is on our end.
          </p>
        ) : (
          <>
            {lists.length === 0 ? <p className={styles.status}>No set lists yet. Make your first one below.</p> : null}
            {lists.map((l) => (
              <label key={l.id} className={styles.check} data-testid="add-set-row">
                <input type="checkbox" checked={l.has_job === true} disabled={busy !== null} onChange={() => toggle(l)} />
                <span>{l.name}</span>
              </label>
            ))}
            {canAddList(lists.length) ? (
              <form onSubmit={create} className={styles.sheetBody} style={{ padding: 0 }}>
                <label className={styles.label} htmlFor="add-set-new">
                  New set list
                </label>
                <input id="add-set-new" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={fieldStyle} autoComplete="off" />
                {error ? (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                ) : null}
                <button type="submit" className={styles.secondary} disabled={busy !== null} data-testid="add-set-create">
                  Create and add
                </button>
              </form>
            ) : null}
          </>
        )}
        <p className={styles.status}>
          <a href="/sets">See your set lists</a>
        </p>
      </div>
    </Sheet>
  );
}
