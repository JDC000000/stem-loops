// Screen Wake Lock while playing (design v1.4, P1.2): the phone must not dim
// mid-song. Held while playing, released on pause; re-requested when the page
// becomes visible again (the browser drops a screen lock whenever the page is
// hidden). Feature-detected: where `navigator.wakeLock` is missing, or a
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
  /** Hold the lock (playing) or let it go (paused, ended). Idempotent. */
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

  const onVisible = () => {
    if (doc?.visibilityState === 'visible') acquire();
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
