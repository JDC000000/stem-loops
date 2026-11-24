'use client';

// /sets/[id] — one set list (#322; Phase B, B2). The Demo set (`demo`) is read-only and works
// signed out; an account's own list can be renamed, reordered (Move up / Move down, 44px and
// keyboard-operable buttons, AC 8), have songs taken out, and be deleted (confirm, and the
// plain sentence that deleting a list never deletes songs, AC 3).
//
// Each playable row opens the player with ?set=<id>, which is what shows "Next song ›".
// Drag to reorder (B2 follow-up): each row of an account's own list also has a drag handle.
// Pointer events only (mouse, touch and pen alike; no library). The handle captures the pointer
// and has `touch-action: none`, so a drag on a phone moves the song and never scrolls the page.
// While dragging, the row shows the selected style (#222 + 2px #fff) and a 2px #fff line marks
// where it will land; on release the whole new order goes in ONE request, the same PUT the Move
// buttons send. The Move buttons stay: they are the keyboard path, so the handle is
// pointer-only and hidden from assistive tech. Reduced motion: the row does not follow the
// pointer; only the landing line and the final order change. A drag ends without a change on
// pointercancel, on lostpointercapture (capture taken away before the release) and on Escape
// (review R1, S4); the row goes back to its place and nothing is sent.
//
// Auto-scroll (#343): while dragging, a pointer within EDGE_ZONE_PX of the top or bottom of the
// viewport scrolls the page (a rAF loop, faster the deeper into the zone), so a list taller
// than a phone screen can be reordered end to end in one drag. Reduced motion: no animated
// scroll; the page jumps a fixed step while the pointer stays over an edge. Any page scroll
// mid-drag (auto-scroll or a mouse wheel) is counted in the row's offset (dragDelta), so the
// row stays under the pointer and the landing line matches where it will save. The loop stops
// on drop, cancel (pointercancel, lostpointercapture, Escape) and unmount.
// Polish (#355): auto-scroll waits until the pointer has moved AUTOSCROLL_ARM_PX from where the
// drag began (a drag that starts in an edge zone does not scroll at once); the speed is px per
// second from the rAF timestamps (dt clamped), so 60Hz and 120Hz scroll alike; a scrollBy that
// throws falls back to the plain scrollBy(x, y) form, so the loop never silently dies; and the
// bottom zone sits above the iOS home-indicator safe area (env(safe-area-inset-bottom)). The root layout opts in with viewport-fit=cover (#360), so that
// inset is real on iOS, and the page body pads by it too.
//
// A row whose song cannot play says why: "Audio expired" (a link: paste it again and the row
// plays the new one), "Unavailable" (an upload or a demo song that is gone), "Processing".
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Sheet } from '@/components/play/Sheet';
import { buttonBase, fieldStyle, primaryButton } from '@/lib/ui/form-styles';
import {
  DELETE_LIST_NOTE,
  DEMO_SET_ID,
  autoScrollStep,
  checkSetListName,
  dragDelta,
  dropIndex,
  autoScrollArmed,
  edgeScrollSpeed,
  itemStateLabel,
  parsePx,
  splitWholePx,
  moveItem,
  reorderItem,
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

/** A drag in progress: which row, where it would land, how far it has moved (px). */
type Drag = { from: number; to: number; dy: number; reduced: boolean };

const prefersReducedMotion = (): boolean => {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** The page's vertical scroll (0 where there is no window). */
const pageScrollY = (): number => globalThis.window?.scrollY ?? 0;

/** True when the pointer is outside both edge zones (full-speed probe; reduced-motion reset). */
const edgeIdle = (clientY: number, viewportH: number, insetBottom: number): boolean =>
  edgeScrollSpeed(clientY, viewportH, undefined, undefined, insetBottom) === 0;

/**
 * The bottom safe-area inset (px): env(safe-area-inset-bottom) resolved by a hidden probe,
 * since a custom property holding env() is not resolved by every engine. 0 when unknown.
 */
const safeAreaBottomPx = (): number => {
  const doc = globalThis.document;
  const win = globalThis.window;
  if (!doc?.body || !win?.getComputedStyle) return 0;
  let probe: HTMLElement | null = null;
  try {
    probe = doc.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('data-safe-area-probe', '');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px)';
    doc.body.appendChild(probe);
    return parsePx(win.getComputedStyle(probe).paddingBottom);
  } catch {
    return 0;
  } finally {
    probe?.remove();
  }
};

/** Scroll the page by `top` px at once. Never throws: an engine that rejects the options form
 *  (or 'instant') gets the plain scrollBy(x, y) form (#355 F3). */
const scrollPageBy = (win: Window, top: number): void => {
  try {
    win.scrollBy({ top, left: 0, behavior: 'instant' as ScrollBehavior });
  } catch {
    try {
      win.scrollBy(0, top);
    } catch {
      // Nothing more to try; the loop keeps running and the row still follows any scroll.
    }
  }
};

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
  const listRef = useRef<HTMLOListElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Measured when a drag starts; the row centres stay fixed for the whole drag. */
  const dragInfo = useRef<{
    pointerId: number;
    startY: number;
    startScrollY: number;
    /** The pointer's latest clientY: auto-scroll and page scroll re-place the row from it. */
    lastY: number;
    /** True once the pointer has moved AUTOSCROLL_ARM_PX: only then may edge auto-scroll run. */
    armed: boolean;
    /** Bottom safe-area inset (px), read when the drag starts. */
    insetBottom: number;
    mids: number[];
    handle: HTMLElement;
  } | null>(null);

  /** End a drag with no change: nothing is sent, the row goes back. Safe to call twice. */
  const cancelDrag = useCallback(() => {
    const info = dragInfo.current;
    if (!info) return;
    dragInfo.current = null;
    setDrag(null);
    try {
      if (info.handle.hasPointerCapture?.(info.pointerId)) info.handle.releasePointerCapture(info.pointerId);
    } catch {
      // Already released.
    }
  }, []);

  /** Re-place the dragged row from the latest pointer position and page scroll. */
  const syncDrag = useCallback(() => {
    const info = dragInfo.current;
    if (!info) return;
    const dy = dragDelta(info.lastY, info.startY, pageScrollY(), info.startScrollY);
    setDrag((d) => {
      if (!d) return d;
      const to = dropIndex(info.mids, d.from, info.mids[d.from] + dy);
      return to === d.to && dy === d.dy ? d : { ...d, to, dy };
    });
  }, []);

  // Escape cancels a drag in progress (mouse or touch).
  const dragging = drag !== null;
  const dragReduced = drag?.reduced ?? false;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancelDrag();
    };
    const win = globalThis.window;
    win?.addEventListener('keydown', onKey);
    return () => win?.removeEventListener('keydown', onKey);
  }, [dragging, cancelDrag]);

  // Auto-scroll near the viewport edges while dragging (#343), and follow any page scroll
  // (wheel or auto) so the row stays under the pointer. Stops on drop, cancel and unmount.
  useEffect(() => {
    if (!dragging) return;
    const win = globalThis.window;
    if (!win) return;
    let frame: number | null = null;
    let lastJumpAt: number | null = null;
    let lastFrameAt: number | null = null;
    let carry = 0;
    const tick = (now: number) => {
      frame = null;
      const info = dragInfo.current;
      if (!info) return;
      const step = autoScrollStep({
        clientY: info.lastY,
        viewportH: win.innerHeight,
        reduced: dragReduced,
        now,
        lastJumpAt,
        lastFrameAt,
        insetBottom: info.insetBottom,
        armed: info.armed,
      });
      lastFrameAt = now;
      if (step !== 0) {
        if (dragReduced) lastJumpAt = now;
        const { px, carry: rest } = splitWholePx(carry + step);
        carry = rest;
        if (px !== 0) {
          scrollPageBy(win, px);
          syncDrag();
        }
      } else if (edgeIdle(info.lastY, win.innerHeight, info.insetBottom)) {
        lastJumpAt = null; // left the edge: the next visit jumps at once
        carry = 0;
      }
      frame = win.requestAnimationFrame?.(tick) ?? null;
    };
    frame = win.requestAnimationFrame?.(tick) ?? null;
    win.addEventListener('scroll', syncDrag, { passive: true });
    return () => {
      if (frame !== null) win.cancelAnimationFrame?.(frame);
      win.removeEventListener('scroll', syncDrag);
    };
  }, [dragging, dragReduced, syncDrag]);

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

  /** Send a whole new order (Move buttons and drag alike: one atomic PUT). */
  const saveOrder = async (current: SetListDetail, order: SetListItem[], done: string) => {
    // Optimistic: the list moves at once; a refusal reloads it as the server has it.
    setState({ kind: 'ok', list: { ...current, items: order.map((it, position) => ({ ...it, position })) } });
    setBusy(true);
    const res = await write(`${api}/songs`, 'PUT', { order: order.map((it) => it.item_id) });
    setBusy(false);
    if (!res?.ok) {
      const b = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
      if (res) setNotice(b?.message ?? 'We could not move that song. Please try again.');
      await load();
    } else {
      setNotice(done);
    }
  };

  const move = async (i: number, dir: 'up' | 'down') => {
    if (!list || busy) return;
    const order = moveItem(list.items, i, dir === 'up' ? -1 : 1);
    const item = list.items[i];
    refocus.current = { item: item.item_id, dir };
    await saveOrder(list, order, `Moved ${item.title} ${dir}.`);
  };

  const onDragStart = (i: number, e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!list || busy || dragInfo.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rows = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-testid="set-item"]')) : [];
    const mids = rows.map((r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    });
    if (mids.length !== list.items.length) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic or already-released pointer: the drag still works while over the handle.
    }
    dragInfo.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startScrollY: pageScrollY(),
      lastY: e.clientY,
      armed: false,
      insetBottom: safeAreaBottomPx(),
      mids,
      handle: e.currentTarget,
    };
    setDrag({ from: i, to: i, dy: 0, reduced: prefersReducedMotion() });
  };

  const onDragMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const info = dragInfo.current;
    if (!info || e.pointerId !== info.pointerId) return;
    info.lastY = e.clientY;
    if (!info.armed && autoScrollArmed(e.clientY, info.startY)) info.armed = true;
    syncDrag();
  };

  const endDrag = (e: ReactPointerEvent<HTMLSpanElement>, commit: boolean) => {
    const info = dragInfo.current;
    if (!info || e.pointerId !== info.pointerId) return;
    if (!commit) return cancelDrag();
    dragInfo.current = null;
    const d = drag;
    setDrag(null);
    if (!d || !list) return;
    const to = dropIndex(info.mids, d.from, info.mids[d.from] + dragDelta(e.clientY, info.startY, pageScrollY(), info.startScrollY));
    if (to === d.from) return;
    const item = list.items[d.from];
    void saveOrder(list, reorderItem(list.items, d.from, to), `Moved ${item.title} to position ${to + 1}.`);
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
          <a className={styles.textLink} href="/sets">‹ Set lists</a>
        </p>
        {state.kind === 'loading' ? null : state.kind === 'signed_out' ? (
          <p className={styles.status}>
            <a className={styles.textLink} href={`/login?return_to=/sets/${encodeURIComponent(id)}`}>Sign in</a> to see this set list.
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
        <a className={styles.textLink} href="/sets">‹ Set lists</a>
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
        <ol className={styles.list} data-testid="set-items" ref={listRef} data-dragging={drag ? 'true' : undefined}>
          {list.items.map((it, i) => {
            const dragged = drag?.from === i;
            const landing = drag && !dragged && drag.to === i ? (drag.to < drag.from ? 'before' : 'after') : undefined;
            const draggable = editable && list.items.length > 1;
            const shift = dragged && drag && !drag.reduced ? { transform: `translateY(${drag.dy}px)` } : undefined;
            const label = itemStateLabel(it.state);
            const playable = it.state === 'ready' && !!it.job_id;
            const body = (
              <>
                <span className={`${styles.pos} ${draggable ? styles.posInHandle : ''}`} aria-hidden="true">
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
              <li
                key={it.item_id}
                className={`${styles.row} ${dragged ? styles.dragging : ''}`}
                style={shift}
                data-item={it.item_id}
                data-testid="set-item"
                data-state={it.state}
                data-drop={landing}
                data-drag={dragged ? 'true' : undefined}
              >
                {draggable ? (
                  <span
                    className={styles.handle}
                    data-testid="set-drag"
                    data-pos={i + 1}
                    aria-hidden="true"
                    title="Drag to reorder"
                    onPointerDown={(e) => onDragStart(i, e)}
                    onPointerMove={onDragMove}
                    onPointerUp={(e) => endDrag(e, true)}
                    onPointerCancel={(e) => endDrag(e, false)}
                    onLostPointerCapture={(e) => {
                      if (dragInfo.current?.pointerId === e.pointerId) cancelDrag();
                    }}
                  />
                ) : null}
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
