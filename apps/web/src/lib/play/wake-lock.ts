// Screen Wake Lock on the player (design v1.4, P1.2; Phase A 2026-11-21): the
// phone must not dim mid-song, NOR while paused (a guitarist pauses to work out
// a shape). The player holds it for as long as its page is visible, playing or
// not. It is released the moment the page is hidden (visibilitychange), and
// re-requested when the page becomes visible again. Feature-detected: where `navigator.wakeLock` is missing, or a
// request is refused (battery saver, permissions policy), nothing breaks.
//
// Pure wiring over injected `navigator` / `document`, so node:test drives it
// with fakes (test/play-wake-lock.test.mjs).

interface SentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}

interface WakeLockNavigator {
  readonly wakeLock?: { request(type: 'screen'): Promise<SentinelLike> };
}

interface VisibilityDocument {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
}

export interface WakeLockController {
  /** Hold the lock (the player is on screen) or let it go. Idempotent. */
  set(wanted: boolean): void;
  dispose(): void;
}

export function wakeLockSupported(nav: unknown): boolean {
  const wl = (nav as WakeLockNavigator | null | undefined)?.wakeLock;
  return !!wl && typeof wl.request === 'function';
}

export function createWakeLock(nav: unknown, doc: VisibilityDocument | null | undefined): WakeLockController {
  if (!wakeLockSupported(nav)) return { set() {}, dispose() {} };
  const api = (nav as Required<WakeLockNavigator>).wakeLock;
  let wanted = false;
  let sentinel: SentinelLike | null = null;
  let pending = false;
  let disposed = false;

  const acquire = () => {
    if (disposed || !wanted || pending || (sentinel && !sentinel.released)) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    pending = true;
    api
      .request('screen')
      .then((s) => {
        pending = false;
        if (disposed || !wanted) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
        });
      })
      .catch(() => {
        pending = false; // refused: carry on without it
      });
  };

  const release = () => {
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) void s.release().catch(() => {});
  };

  // Hidden: let the lock go now (the browser would drop it anyway; doing it
  // ourselves means no sentinel is left looking held). Visible: take it back.
  const onVisible = () => {
    if (doc?.visibilityState === 'visible') acquire();
    else release();
  };
  doc?.addEventListener('visibilitychange', onVisible);

  return {
    set(next: boolean) {
      wanted = next;
      if (next) acquire();
      else release();
    },
    dispose() {
      disposed = true;
      wanted = false;
      release();
      doc?.removeEventListener('visibilitychange', onVisible);
    },
  };
}
