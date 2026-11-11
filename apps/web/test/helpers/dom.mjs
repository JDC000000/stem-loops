/**
 * Opt-in DOM environment for node:test.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo's runner is node:test, which has no DOM. Pure helpers were testable;
 * interactive wiring (pointer drags, pointer capture, window-level keydown, React
 * effects and timers) was not. Import this helper from the test files that need a
 * DOM; every other test file is untouched and pays nothing.
 *
 * It is deliberately NOT a global setup file. node:test runs one process per test
 * file, so a file that never imports this helper never loads happy-dom at all.
 *
 * WHY happy-dom AND NOT jsdom
 * ---------------------------
 * Measured, not assumed:
 *   - jsdom 31.0.0 does not implement `setPointerCapture` / `releasePointerCapture` /
 *     `hasPointerCapture` ANYWHERE on the prototype chain. A real drag handler that
 *     calls `e.currentTarget.setPointerCapture(e.pointerId)` throws "is not a
 *     function" under jsdom. That is precisely the wiring this project needs to test.
 *   - happy-dom 21.0.4 implements all three and tracks capture state.
 *   - happy-dom is also ~4.6x cheaper to construct (7.8ms vs 36.2ms per window).
 *
 * WHAT THIS HARNESS GENUINELY COVERS
 * ----------------------------------
 * Pointer drags with real capture state; window-level keyboard shortcuts; effect
 * mount/cleanup ordering; listener teardown; timer wiring; and animation-frame
 * wiring via a controlled frame clock (see FRAMES below).
 *
 * WHAT IT CANNOT COVER — read this before trusting a green test
 * -------------------------------------------------------------
 *   - LAYOUT. There is no layout engine. `getBoundingClientRect()` is all zeros AND
 *     `offsetWidth` / `offsetHeight` / `clientWidth` / `clientHeight` / `scrollWidth` /
 *     `scrollHeight` are ALL 0. Any defect that depends on real measured geometry
 *     (an overflow at a given viewport width, say) is unreachable by construction.
 *     `dom.stubRect()` injects both the rect and the box metrics so such a case can
 *     be *expressed*, but you are then asserting against numbers you supplied.
 *     Beware: `getComputedStyle(el).width` returns the DECLARED inline/CSS value, not
 *     a computed layout value, so a test can read computed style and wrongly believe
 *     it has layout.
 *   - WEB AUDIO. There is no `AudioContext` at all. For an audio product this is the
 *     core of the thing, and none of it is exercised here.
 *   - PAINT, CSS cascade effects on geometry, and real input devices.
 *   - happy-dom's pointer capture does not RETARGET events: while element A holds
 *     capture, an event dispatched on B is still delivered to B, where a browser
 *     retargets to A. `dom.drag()` fires every move at the capturing element, which
 *     is what a browser delivers anyway once capture is held — but a component that
 *     relies on retargeting is being tested under slightly wrong semantics.
 *   - `gotpointercapture` / `lostpointercapture` are never fired. Assert on
 *     `hasPointerCapture()` instead.
 *   - happy-dom's DOM classes are mostly MODULE-LEVEL SINGLETONS shared by every
 *     window, so `Element.prototype` is shared across withDom() calls. Measured on
 *     happy-dom 21.0.4: a window exposes 375 class-shaped own properties, of which
 *     300 are `===` across two windows (`Element`, every `HTML*Element`, every event
 *     class including `PointerEvent` and `KeyboardEvent`, `CSSStyleDeclaration`,
 *     `DOMRect`, `Window`) and 75 are rebuilt per window (`Document`, `EventTarget`,
 *     `DocumentFragment`, `MutationObserver`, `DOMParser`, `Text`, `Range`).
 *     The harness watches the prototype of ALL 375 — derived from the window, not a
 *     hardcoded list — and reverts pollution at teardown and fails the test. It
 *     still cannot give you per-window classes. An earlier hardcoded list of six
 *     left 369 unwatched, so `HTMLMediaElement.prototype.play = stub` was neither
 *     reported nor reverted and was still live in the next call.
 *   - GLOBALS are snapshotted by descriptor, string keys AND symbol keys, so
 *     `globalThis[Symbol.for('app.singleton')] = x` is reported and reverted like
 *     any other. ONE exemption, by name: `Symbol(undici.globalDispatcher.1)`, which
 *     Node creates lazily on the process's first `fetch()`. A body that deliberately
 *     plants that exact symbol is not reported. See HARNESS_OWNED_SYMBOLS: the
 *     exemption is defensive and currently INERT, because importing happy-dom
 *     already creates the symbol before any snapshot is taken.
 *   - A THROWING EFFECT CLEANUP POISONS THE REST OF ITS FILE, and the harness
 *     cannot stop it. React 18.3.1 does not recover from a cleanup that throws out
 *     of `act()`: react-dom's module-level `executionContext` is left non-zero (and
 *     React's `ReactCurrentActQueue.current` is left dirty — instrumented at 2
 *     entries, growing to 4 by the next React test). A LATER test in the same
 *     PROCESS that goes through the async act path then dies with
 *     "Should not already be working." and a stack pointing only into React.
 *     `executionContext` is a module-local with no internals handle, so this is not
 *     repairable from out here. THE RULE: a test that makes an effect cleanup throw
 *     goes LAST in its file, or in a file of its own. This harness's own suite
 *     follows it (see section 10 of dom.test.mjs) — appending one ordinary
 *     React-mounting test after that test was enough to make it fail.
 *   - These files are NOT type-checked. `apps/web/tsconfig.json` includes only
 *     TypeScript sources (.ts and .tsx), so nothing under `test/` enters the tsc
 *     program; the @typedef below is documentation, not a checked contract.
 *
 * FRAMES
 * ------
 * Animation frames are MANUAL by default. happy-dom drives `requestAnimationFrame`
 * off a real timer, which makes the single most important component shape here — a
 * transport playhead doing `rAF -> setState -> rAF` — impossible to test: the queue
 * refills faster than `act()` can drain it, so `mount()` never returns and the test
 * hangs. So `requestAnimationFrame` queues the callback and nothing runs until the
 * test asks:
 *
 *     await dom.nextFrame();      // runs exactly one frame's callbacks, inside act()
 *     dom.pendingFrames;          // how many are queued
 *
 * Callbacks that re-schedule land in the NEXT frame, so a continuous loop advances
 * one frame per call instead of running away.
 *
 * A FRAME LEFT QUEUED AT TEARDOWN FAILS THE TEST, automatically — you do not have to
 * remember `assert.equal(dom.pendingFrames, 0)`. That matters because a forgotten
 * `cancelAnimationFrame(id)` in an effect cleanup produces React noise under real
 * frames but PURE SILENCE under this clock, which reverses the inference the rest of
 * teardown invites (globals and prototypes are checked automatically, and timers are
 * aborted automatically by `happyDOM.close()`).
 *
 * TIMESTAMPS are real: the value passed to each callback is `window.performance.now()`
 * — the same clock a component reads, and `window.performance === globalThis.performance`,
 * so there is no separate time origin. But it advances by however long the test took,
 * NOT by ~16.67ms. A component asserting on frame-to-frame deltas is not being tested
 * against browser timing.
 *
 * `{ realFrames: true }` hands frames back to happy-dom's timer, and costs three
 * things. Know all three before reaching for it:
 *   1. `dom.pendingFrames` THROWS. happy-dom owns the queue, so the harness cannot
 *      count it; returning the old permanent 0 made `assert.equal(dom.pendingFrames, 0)`
 *      — the documented idiom for "the cleanup cancelled the frame" — pass vacuously,
 *      silently disarming every frame-leak assertion in that test.
 *   2. `dom.nextFrame()` returns 1 unconditionally, not a count of callbacks run.
 *   3. The mount hang comes back for the rAF -> setState -> rAF shape: `act()` never
 *      reaches quiescence, `mount()` never returns, and the suite hangs rather than
 *      failing (measured past 90s).
 *
 * One consequence of always installing a frame clock: a component written as
 * `if (typeof requestAnimationFrame === 'function') ... else setTimeout(run, 16)` —
 * `defaultScheduler` in `src/components/play/Mixer.tsx` is exactly this shape — can
 * never take its `else` branch under this harness. That fallback is untestable here.
 *
 * TWO WAYS THE FRAME CLOCK DIVERGES FROM A BROWSER — documented, not fixed
 * ------------------------------------------------------------------------
 * `nextFrame()` takes the queue, REPLACES it with a fresh Map, and then iterates the
 * copy. Two browser behaviours fall out of that, both demonstrated:
 *
 *   1. Callback A cancelling a sibling B scheduled in the SAME frame is a no-op here,
 *      so both run (`nextFrame()` returns 2). The HTML spec sets B's cancelled flag
 *      and runs only A. `cancelFrame` deletes from the NEW map, not the one being
 *      iterated.
 *   2. If callback A throws, B never runs AND IS PERMANENTLY LOST (`pendingFrames`
 *      reads 0), and the throw propagates out of `nextFrame()`. A browser reports the
 *      error and still runs B. This one is the sharper trap: a test that legitimately
 *      catches an expected rAF error then sees `pendingFrames === 0` and a component
 *      that looks stopped.
 *
 * Both are left as they are deliberately. Fixing (1) means mutating the map being
 * iterated; fixing (2) means deciding, for a test harness, which of several
 * browser error-reporting semantics to emulate. Neither is needed by the component
 * shapes this harness exists for, and both are cheaper to know about than to
 * approximate badly. If a component ever depends on either, fix it then — and note
 * that neither is currently pinned by a test, so a change here is unguarded.
 *
 * USAGE
 * -----
 *   import { withDom } from './dom.mjs';
 *
 *   await withDom(async (dom) => {
 *     await dom.mount(React.createElement(Fader));
 *     const el = dom.find('[data-testid="fader"]');
 *     await dom.drag(el, [[0, 0], [64, 0]]);   // down, move(s), up — with capture
 *     await dom.keydown(' ');                   // window-level; code === 'Space'
 *   });
 */

import { Window } from 'happy-dom';

/**
 * Globals installed onto `globalThis` for the duration of the body.
 *
 * This is a curated allowlist, not "copy everything happy-dom has". Blanket-copying
 * would shadow Node builtins the rest of the process depends on (fetch, URL, Blob,
 * console, performance, crypto...) and is a known source of mystery breakage. Anything
 * not listed here is still reachable as `dom.window.Thing`.
 *
 * Timers ARE taken from the window on purpose: `happyDOM.close()` aborts the window's
 * task manager, so a component's pending setTimeout/setInterval is cancelled at
 * teardown instead of firing during the next test. That is the classic DOM-harness flake.
 */
const INSTALLED_GLOBALS = [
  // Core
  'window', 'document', 'navigator', 'location', 'history',
  // Nodes & elements
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLDivElement', 'HTMLSpanElement', 'HTMLFormElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLCanvasElement', 'HTMLMediaElement',
  'HTMLAudioElement', 'DocumentFragment', 'ShadowRoot', 'DOMRect', 'DOMParser',
  // Events
  'Event', 'CustomEvent', 'EventTarget', 'UIEvent', 'PointerEvent', 'MouseEvent',
  'KeyboardEvent', 'FocusEvent', 'InputEvent', 'WheelEvent', 'TouchEvent', 'DragEvent',
  'SubmitEvent', 'ErrorEvent',
  // Observers & style
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'getComputedStyle', 'matchMedia', 'CSS', 'CSSStyleDeclaration',
  // Frames & timers (see note above; frames are replaced by the controlled clock)
  'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // Storage
  'localStorage', 'sessionStorage',
];

/** Names the globalThis pollution check ignores, because the harness owns them. */
const HARNESS_OWNED = new Set([...INSTALLED_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']);

/**
 * Symbol-keyed globals the pollution check must leave alone.
 *
 * Node creates `Symbol(undici.globalDispatcher.1)` on globalThis LAZILY — absent in a
 * bare `node -e`, present after the first `fetch()`. Without the exemption, a body
 * that fetches would look like it ADDED it and the harness would DELETE it, breaking
 * fetch for every later test in the file.
 *
 * BE CLEAR ABOUT WHAT THIS IS WORTH TODAY: it is defensive, not load-bearing.
 * Measured — importing `happy-dom` already creates the symbol, so by the time any
 * file that imports this harness takes its first snapshot the symbol is already in
 * it, and the exemption changes nothing. Removing this line passes the whole suite.
 * It is kept because it costs one Set entry and the failure it would prevent (fetch
 * dead for the rest of the file, caused by a teardown "fix") is bad and hard to
 * diagnose if happy-dom ever stops touching undici at import time.
 *
 * The cost: a body that deliberately plants this exact symbol is not reported.
 */
const HARNESS_OWNED_SYMBOLS = [Symbol.for('undici.globalDispatcher.1')];

/** What the globalThis check skips: the harness's own globals plus those symbols. */
const GLOBAL_CHECK_IGNORES = new Set([...HARNESS_OWNED, ...HARNESS_OWNED_SYMBOLS]);

/**
 * Every DOM class a happy-dom window exposes, for the prototype-pollution check.
 *
 * DERIVED, not hardcoded. The previous hardcoded six (`Node`, `Element`,
 * `HTMLElement`, `Document`, `Event`, `EventTarget`) left the prototypes of 369 other
 * classes unwatched — `HTMLMediaElement`, `PointerEvent`, `KeyboardEvent`,
 * `CSSStyleDeclaration`, `DOMRect` among them — so polluting them was neither
 * detected nor reverted and the residue reached the next withDom() call. Two of the
 * six were not even shared between windows, which is how a stale list rots.
 *
 * Only `value` descriptors are inspected, so no getter on the window is invoked.
 * Measured on happy-dom 21.0.4: 375 class-shaped own properties, none behind a
 * getter. Prototypes are de-duplicated by identity.
 */
function watchedPrototypes(window) {
  const seen = new Set();
  const found = [];
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(window))) {
    if (!('value' in descriptor)) continue;
    const value = descriptor.value;
    if (typeof value !== 'function') continue;
    if (!Object.prototype.hasOwnProperty.call(value, 'prototype')) continue;
    const object = value.prototype;
    if (object === null || typeof object !== 'object') continue;
    if (seen.has(object)) continue;
    seen.add(object);
    found.push({ name, object });
  }
  return found;
}

/** Browser `KeyboardEvent.code` values that are not derivable from `key`. */
const EXPLICIT_KEY_CODES = {
  ' ': 'Space',
  Spacebar: 'Space',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '`': 'Backquote',
};

/**
 * Best-effort `KeyboardEvent.code` for a `key`. Browsers derive `code` from the
 * physical key, so this cannot be exact for every layout — but it must at least get
 * Space and the digits right, because `e.code === 'Space'` is how a transport
 * play/pause shortcut is normally written. Pass `code` explicitly to override.
 */
export function codeForKey(key) {
  if (typeof key !== 'string') return undefined;
  if (key in EXPLICIT_KEY_CODES) return EXPLICIT_KEY_CODES[key];
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  // 'Enter', 'Tab', 'ArrowLeft', 'Escape', 'F5', 'Home'... are already code-shaped.
  return key;
}

/** Re-entrancy guard: nested withDom would clobber the outer call's globals. */
let active = false;

const define = (key, value) =>
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });

/** Every own key of `target`, string-keyed and symbol-keyed alike. */
const ownKeys = (target) => [
  ...Object.getOwnPropertyNames(target),
  ...Object.getOwnPropertySymbols(target),
];

/**
 * Snapshot every own property descriptor of `target`. Does not invoke getters.
 *
 * Symbols are included: `globalThis[Symbol.for('app.singleton')] = x` is a common
 * singleton idiom, and a names-only snapshot let it leak across withDom() calls
 * entirely unreported.
 */
function describeOwn(target) {
  const map = new Map();
  for (const key of ownKeys(target)) {
    map.set(key, Object.getOwnPropertyDescriptor(target, key));
  }
  return map;
}

/** Object.is on `value` so NaN compares equal to itself. */
function sameDescriptor(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return (
    Object.is(a.value, b.value) &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

/**
 * Revert `target`'s own properties to `snapshot`, reporting every difference found.
 *
 * This catches MODIFICATION, not just addition. A body that does
 * `globalThis.fetch = stub` leaves a name that already existed, so a
 * getOwnPropertyNames diff sees nothing — which is exactly how a stubbed fetch
 * silently poisons every later test in a file.
 *
 * Symbol keys are covered on both passes. `String(key)` rather than a template
 * interpolation, because interpolating a symbol throws.
 *
 * @returns {string[]} human-readable descriptions of what the body changed
 */
function revertOwn(label, target, snapshot, ignore = new Set()) {
  const problems = [];

  for (const key of ownKeys(target)) {
    if (ignore.has(key) || snapshot.has(key)) continue;
    try {
      delete target[key];
      problems.push(`${label}.${String(key)} was added`);
    } catch (error) {
      problems.push(`${label}.${String(key)} was added and could not be removed (${error.message})`);
    }
  }

  for (const [key, before] of snapshot) {
    if (ignore.has(key)) continue;
    const now = Object.getOwnPropertyDescriptor(target, key);
    if (sameDescriptor(before, now)) continue;
    const what = now === undefined ? 'was deleted' : 'was modified';
    try {
      Object.defineProperty(target, key, before);
      problems.push(`${label}.${String(key)} ${what}`);
    } catch (error) {
      problems.push(`${label}.${String(key)} ${what} and could not be restored (${error.message})`);
    }
  }

  return problems;
}

/**
 * Run `body` with a fresh DOM installed on globalThis, then tear it down completely.
 *
 * Teardown is unconditional and never masks the body's own failure: if the body
 * throws, that error is what the caller sees, with any teardown problems attached as
 * `error.cause`. If the body succeeds, teardown problems become the failure.
 *
 * @template T
 * @param {(dom: DomHarness) => Promise<T> | T} body
 * @param {{ url?: string, html?: string, realFrames?: boolean }} [options]
 * @returns {Promise<T>} whatever `body` returned
 */
export async function withDom(body, options = {}) {
  if (active) {
    throw new Error(
      'withDom() is already active — nested calls would clobber the outer call\'s globals. ' +
      'Use one withDom() per test.',
    );
  }
  active = true;
  try {
    return await runWithDom(body, options);
  } finally {
    // Clears `active` wherever runWithDom() left off, INCLUDING its install phase:
    // `new Window({ url })` on a typo'd url, document.write(), the define() loop and
    // the post-install snapshots all sit outside any try/finally of their own. One
    // bad option used to wedge the helper for the rest of the file, and every later
    // call in that file then failed with a misleading "already active".
    active = false;
  }
}

/** The body of withDom(). Only called with `active` already set, by withDom(). */
async function runWithDom(body, options) {
  const {
    url = 'http://localhost:3000/',
    html = '<!doctype html><html><body></body></html>',
    realFrames = false,
  } = options;

  // Descriptors (not values) for the globals the harness itself installs: the only
  // way to restore an absent global as absent, and to put back Node's getter-only
  // `navigator`, which a plain assignment cannot overwrite at all.
  const savedHarnessGlobals = new Map();
  for (const key of [...INSTALLED_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) {
    savedHarnessGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const window = new Window({ url });
  window.document.write(html);

  // --- controlled frame clock (see FRAMES in the header) -------------------
  let frameSeq = 0;
  let frameQueue = new Map();
  const requestFrame = (callback) => {
    const id = (frameSeq += 1);
    frameQueue.set(id, callback);
    return id;
  };
  const cancelFrame = (id) => {
    frameQueue.delete(id);
  };
  if (!realFrames) {
    window.requestAnimationFrame = requestFrame;
    window.cancelAnimationFrame = cancelFrame;
  }

  // --- install ------------------------------------------------------------
  define('window', window);
  for (const key of INSTALLED_GLOBALS) {
    if (key === 'window') continue;
    const value = window[key];
    if (value !== undefined) define(key, value);
  }
  // React's act() requires this flag; without it React warns on every update.
  define('IS_REACT_ACT_ENVIRONMENT', true);

  // Snapshot AFTER installing, so the diff at teardown attributes changes to the
  // body rather than to the harness's own footprint.
  const globalsAfterInstall = describeOwn(globalThis);
  const prototypesAfterInstall = watchedPrototypes(window)
    .map(({ name, object }) => ({ name, object, snapshot: describeOwn(object) }));

  /** host element -> React root, unmounted in reverse order at teardown. */
  const roots = new Map();
  /** Lazily imported so react-dom only ever evaluates with DOM globals present. */
  let React;
  let createRoot;

  const loadReact = async () => {
    if (!React) {
      React = (await import('react')).default;
      // react-dom/client feature-detects the DOM at module evaluation time, which is
      // why this import happens here and not at the top of the file.
      ({ createRoot } = await import('react-dom/client'));
    }
    return React;
  };

  /** @type {DomHarness} */
  const dom = {
    window,
    document: window.document,

    /** The <body> element of the fresh document. */
    get body() {
      return window.document.body;
    },

    /**
     * How many animation-frame callbacks are queued.
     *
     * Throws under `{ realFrames: true }`. happy-dom then drives
     * requestAnimationFrame off its own timer and the harness never sees the queue,
     * so this would read a permanent 0 — and `assert.equal(dom.pendingFrames, 0)`,
     * the documented idiom for "the cleanup cancelled the frame", would pass
     * vacuously. Disarming a leak assertion silently is worse than refusing to
     * answer, so it refuses.
     */
    get pendingFrames() {
      if (realFrames) {
        throw new Error(
          'dom.pendingFrames is unavailable under { realFrames: true }: happy-dom owns ' +
          'the frame queue, so the harness cannot count it and a 0 here would make ' +
          'every frame-leak assertion pass vacuously. Drop realFrames to use the ' +
          'controlled clock.',
        );
      }
      return frameQueue.size;
    },

    /**
     * Run `fn` inside React's act(), flushing state updates, effects and the
     * microtask queue. Safe to call with a sync or async fn.
     */
    async act(fn) {
      const R = await loadReact();
      await R.act(async () => {
        await fn?.();
      });
    },

    /**
     * Mount a React element into a fresh host div appended to <body>.
     * Effects run. Returns the host element.
     */
    async mount(element) {
      const R = await loadReact();
      const host = window.document.createElement('div');
      window.document.body.appendChild(host);
      const root = createRoot(host);
      roots.set(host, root);
      await R.act(async () => {
        root.render(element);
      });
      return host;
    },

    /** Re-render an already-mounted root (by its host, as returned from mount). */
    async rerender(host, element) {
      const R = await loadReact();
      const root = roots.get(host);
      if (!root) throw new Error('rerender(): that host was not produced by dom.mount()');
      await R.act(async () => {
        root.render(element);
      });
      return host;
    },

    /** Unmount every root created via dom.mount, running effect cleanups. */
    async unmountAll() {
      const R = await loadReact();
      const entries = [...roots.entries()].reverse();
      roots.clear();
      await R.act(async () => {
        for (const [, root] of entries) root.unmount();
      });
    },

    /** querySelector against the document. */
    find(selector) {
      return window.document.querySelector(selector);
    },

    /** querySelectorAll against the document, as a real array. */
    findAll(selector) {
      return [...window.document.querySelectorAll(selector)];
    },

    /**
     * Dispatch one pointer event, wrapped in act() so React state settles.
     * `target` is the element; everything else is PointerEvent init.
     */
    async pointer(type, target, init = {}) {
      const R = await loadReact();
      const event = new window.PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await R.act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    },

    /**
     * A full drag: pointerdown at points[0], pointermove for each subsequent point,
     * pointerup at the last. Every event is dispatched at `target`, which is also
     * what a real browser delivers once the element has taken pointer capture.
     *
     * @param {Element} target
     * @param {Array<[number, number]>} points [[clientX, clientY], ...] (>= 1)
     * @param {{ pointerId?: number }} [init]
     */
    async drag(target, points, init = {}) {
      if (!Array.isArray(points) || points.length === 0) {
        throw new Error('drag(): needs at least one [clientX, clientY] point');
      }
      const pointerId = init.pointerId ?? 1;
      const at = (i) => ({ pointerId, clientX: points[i][0], clientY: points[i][1] });
      await dom.pointer('pointerdown', target, at(0));
      for (let i = 1; i < points.length; i++) {
        await dom.pointer('pointermove', target, at(i));
      }
      await dom.pointer('pointerup', target, at(points.length - 1));
    },

    /**
     * Dispatch a keydown. Defaults to `window` as the target, because window-level
     * keyboard shortcuts are the thing this harness exists to test. Pass `target` to
     * aim it at an element instead, and `code` to override the derived value.
     */
    async keydown(key, init = {}) {
      return dom.keyEvent('keydown', key, init);
    },

    async keyup(key, init = {}) {
      return dom.keyEvent('keyup', key, init);
    },

    async keyEvent(type, key, init = {}) {
      const R = await loadReact();
      const { target = window, ...rest } = init;
      const event = new window.KeyboardEvent(type, {
        key,
        code: codeForKey(key),
        bubbles: true,
        cancelable: true,
        ...rest,
      });
      await R.act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    },

    /**
     * Run exactly one frame's worth of animation-frame callbacks, inside act() so any
     * resulting React updates are flushed. Callbacks that re-schedule land in the next
     * frame, so a continuous loop advances one step per call.
     *
     * @returns {Promise<number>} how many callbacks ran
     */
    async nextFrame() {
      if (realFrames) {
        await dom.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
        return 1;
      }
      const due = frameQueue;
      frameQueue = new Map();
      const now = window.performance?.now?.() ?? Date.now();
      await dom.act(async () => {
        for (const callback of due.values()) callback(now);
      });
      return due.size;
    },

    /** Run `count` frames in sequence. */
    async frames(count) {
      let ran = 0;
      for (let i = 0; i < count; i++) ran += await dom.nextFrame();
      return ran;
    },

    /**
     * Let the window's timers advance by `ms` of real time, inside act() so any
     * resulting React updates are flushed before this resolves.
     */
    async advance(ms) {
      await dom.act(() => new Promise((resolve) => window.setTimeout(resolve, ms)));
    },

    /**
     * Give one element a layout box. happy-dom has no layout engine, so
     * getBoundingClientRect() AND every box metric (offset/client/scrollWidth and
     * friends) read 0 until told otherwise.
     *
     * Pass `metrics` to diverge the metrics from the rect — which is how you express
     * an overflow case, e.g. `{ width: 334, metrics: { scrollWidth: 347 } }`.
     *
     * Remember you are asserting against numbers you supplied, not measured layout.
     */
    stubRect(element, rect = {}) {
      const { metrics = {}, ...boxInput } = rect;
      const box = {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        ...boxInput,
      };
      if (boxInput.width !== undefined && boxInput.right === undefined) box.right = box.left + box.width;
      if (boxInput.height !== undefined && boxInput.bottom === undefined) box.bottom = box.top + box.height;
      element.getBoundingClientRect = () => ({ ...box, toJSON: () => box });

      const resolved = {
        offsetWidth: box.width, offsetHeight: box.height,
        clientWidth: box.width, clientHeight: box.height,
        scrollWidth: box.width, scrollHeight: box.height,
        ...metrics,
      };
      for (const [key, value] of Object.entries(resolved)) {
        Object.defineProperty(element, key, { value, writable: true, configurable: true });
      }
      return element;
    },
  };

  let bodyError;
  let result;
  try {
    result = await body(dom);
  } catch (error) {
    bodyError = error ?? new Error('withDom(): body threw a falsy value');
  }

  // --- teardown -----------------------------------------------------------
  // Everything below runs whether or not the body threw, and nothing below is
  // allowed to replace the body's error.
  const problems = [];

  // 1. Unmount, so effect cleanups run against a live DOM. A cleanup that throws is
  //    a real defect (the audio-context-close-on-null shape), so it is reported —
  //    not swallowed — unless the body already failed and would mask it anyway.
  if (roots.size && React) {
    try {
      await dom.unmountAll();
    } catch (error) {
      problems.push(`a React effect cleanup threw during teardown: ${error.message}`);
    }
  }

  // 2. A leaked animation frame. happyDOM.close() below aborts the window's pending
  //    TIMERS, but the controlled frame queue is the harness's own and nothing
  //    cancels it — so a component whose cleanup forgets cancelAnimationFrame()
  //    leaves a live callback here. Under real frames that forgotten cancel produces
  //    React noise; under the controlled clock it is pure silence, which reverses the
  //    inference every other check in this block invites. So the harness says it,
  //    automatically, instead of relying on each test to assert pendingFrames === 0.
  if (!realFrames && frameQueue.size) {
    const n = frameQueue.size;
    frameQueue.clear();
    problems.push(
      `${n} animation frame callback(s) were still queued at teardown — an effect ` +
      'cleanup is missing cancelAnimationFrame(), or the test meant to drain them ' +
      'with dom.nextFrame()',
    );
  }

  // 3. Close the window: aborts its pending timers and intervals.
  try {
    await window.happyDOM?.close?.();
  } catch (error) {
    problems.push(`happyDOM.close() threw: ${error.message}`);
  }

  // 4. Detect and revert anything the body changed on globalThis — additions AND
  //    modifications — and any pollution of the shared DOM prototypes.
  try {
    problems.push(...revertOwn('globalThis', globalThis, globalsAfterInstall, GLOBAL_CHECK_IGNORES));
  } catch (error) {
    problems.push(`globalThis pollution check failed: ${error.message}`);
  }
  for (const { name, object, snapshot } of prototypesAfterInstall) {
    try {
      problems.push(...revertOwn(`${name}.prototype`, object, snapshot));
    } catch (error) {
      problems.push(`${name}.prototype pollution check failed: ${error.message}`);
    }
  }

  // 5. Uninstall the harness's own globals. Guarded PER KEY, so one irreversible
  //    global (a non-configurable redefinition) is reported by name instead of
  //    escaping as a raw TypeError that names no harness and skips every key after
  //    it. `active` is cleared by withDom()'s own finally, whatever happens here.
  for (const [key, descriptor] of savedHarnessGlobals) {
    try {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    } catch (error) {
      problems.push(`could not restore globalThis.${key}: ${error.message}`);
    }
  }

  if (bodyError) {
    if (problems.length) {
      const detail = `withDom() teardown also reported: ${problems.join('; ')}`;
      if (bodyError instanceof Error) {
        // APPEND, never `??=`. A body error built as `new Error(msg, { cause })` —
        // increasingly common — already carries a cause, and `??=` silently DROPPED
        // the teardown detail, so the leak went unreported in exactly the case this
        // branch exists to handle. The body's own cause is kept, one level down.
        bodyError.cause = bodyError.cause === undefined
          ? new Error(detail)
          : new Error(detail, { cause: bodyError.cause });
      } else {
        // A non-Error throw cannot carry a cause: assigning to a primitive throws in
        // strict module code, and that TypeError REPLACED the body's failure — the
        // caller lost the real error entirely. Wrap instead, keeping the thrown value
        // reachable as `.cause`. (A body that throws a non-Error and leaks nothing
        // still propagates unchanged: this whole branch is inside `problems.length`.)
        throw new Error(
          `withDom(): body threw a non-Error value (${typeof bodyError}): ` +
          `${String(bodyError)} — ${detail}`,
          { cause: bodyError },
        );
      }
    }
    throw bodyError;
  }
  if (problems.length) {
    throw new Error(`withDom() teardown problems: ${problems.join('; ')}`);
  }
  return result;
}

/** True while a withDom() body is running. Exposed for the harness's own tests. */
export const domIsActive = () => active;

/**
 * @typedef {object} DomHarness
 * @property {import('happy-dom').Window} window
 * @property {Document} document
 * @property {HTMLElement} body
 * @property {number} pendingFrames
 * @property {(fn?: () => unknown) => Promise<void>} act
 * @property {(element: unknown) => Promise<HTMLElement>} mount
 * @property {(host: HTMLElement, element: unknown) => Promise<HTMLElement>} rerender
 * @property {() => Promise<void>} unmountAll
 * @property {(selector: string) => Element | null} find
 * @property {(selector: string) => Element[]} findAll
 * @property {(type: string, target: Element, init?: object) => Promise<Event>} pointer
 * @property {(target: Element, points: Array<[number, number]>, init?: object) => Promise<void>} drag
 * @property {(key: string, init?: object) => Promise<Event>} keydown
 * @property {(key: string, init?: object) => Promise<Event>} keyup
 * @property {(type: string, key: string, init?: object) => Promise<Event>} keyEvent
 * @property {() => Promise<number>} nextFrame
 * @property {(count: number) => Promise<number>} frames
 * @property {(ms: number) => Promise<void>} advance
 * @property {(element: Element, rect?: object) => Element} stubRect
 */
