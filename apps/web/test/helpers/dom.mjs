/**
 * Opt-in DOM environment for node:test.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo's runner is node:test, which has no DOM. Pure helpers were testable;
 * interactive wiring (pointer drags, pointer capture, window-level keydown, React
 * effects and timers) was not. Import this helper from the handful of test files
 * that need a DOM; every other test file is untouched and pays nothing.
 *
 * It is deliberately NOT a global setup file. node:test runs one process per test
 * file, so a file that never imports this helper never loads happy-dom at all.
 *
 * WHY happy-dom AND NOT jsdom
 * ---------------------------
 * Measured, not assumed (see the PR description for the probe output):
 *   - jsdom 31.0.0 does not implement `setPointerCapture` / `releasePointerCapture` /
 *     `hasPointerCapture` ANYWHERE on the prototype chain. A real drag handler that
 *     calls `e.currentTarget.setPointerCapture(e.pointerId)` throws "is not a
 *     function" under jsdom. That is precisely the wiring this project needs to test.
 *   - happy-dom 21.0.4 implements all three and tracks capture state
 *     (`hasPointerCapture` flips true on set, false on release).
 *   - happy-dom is also ~4.6x cheaper to construct (7.8ms vs 36.2ms per window).
 *
 * WHAT THIS HARNESS STILL CANNOT DO
 * ---------------------------------
 *   - An unbounded rAF -> setState loop (a playhead ticking every frame) cannot be
 *     driven inside act(): the queue refills from a timer faster than act() can
 *     drain it and act() never reaches quiescence. Test such a loop by asserting on
 *     the frame callback's side effects, not on rendered state (see dom.test.mjs).
 *   - No real layout, so nothing that depends on measured geometry, scroll position
 *     or element visibility is exercised. Use dom.stubRect() to inject geometry.
 *   - No Web Audio (no AudioContext), so audio graph wiring stays untested here.
 *   - It does not replace a browser test. It covers event wiring and React
 *     lifecycle, not paint, CSS cascade or real input devices.
 *
 * WHERE happy-dom DIVERGES FROM A BROWSER (assert against these, don't assume parity):
 *   - Pointer capture does NOT retarget events: while element A holds capture, an
 *     event dispatched on B is still delivered to B. Real browsers retarget to A.
 *     Fire drag moves at the capturing element directly — dom.drag() does exactly that,
 *     which is also what a browser ends up delivering once capture is held.
 *   - `gotpointercapture` / `lostpointercapture` are never fired. Assert on
 *     hasPointerCapture() instead of on those events.
 *
 * USAGE
 * -----
 *   import { withDom } from './dom.mjs';
 *
 *   await withDom(async (dom) => {
 *     const host = await dom.mount(React.createElement(Fader));
 *     const el = dom.find('[data-testid="fader"]');
 *     await dom.drag(el, [[0, 0], [64, 0]]);   // down, move(s), up — with capture
 *     await dom.keydown(' ');                   // window-level keydown
 *     assert.match(host.innerHTML, /v=64/);
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
 * task manager, so a component's pending setTimeout/setInterval/rAF is cancelled at
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
  // Frames & timers (see note above)
  'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // Storage
  'localStorage', 'sessionStorage',
];

/** Re-entrancy guard: nested withDom would clobber the outer call's globals. */
let active = false;

const define = (key, value) =>
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });

/**
 * Run `body` with a fresh DOM installed on globalThis, then tear it down completely.
 *
 * Teardown is unconditional (runs even if `body` throws) and restores every global
 * to the exact property descriptor it had before — including re-installing Node's
 * getter-only `navigator` and deleting globals that did not previously exist.
 *
 * @template T
 * @param {(dom: DomHarness) => Promise<T> | T} body
 * @param {{ url?: string, html?: string }} [options]
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

  const { url = 'http://localhost:3000/', html = '<!doctype html><html><body></body></html>' } = options;

  // Snapshot descriptors (not values): the only way to restore an absent global as
  // absent, and Node's accessor-only `navigator` as an accessor.
  const saved = new Map();
  for (const key of INSTALLED_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const savedActEnv = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));

  const window = new Window({ url });
  window.document.write(html);

  // Install. `window` first so anything reading it during install sees a DOM.
  define('window', window);
  for (const key of INSTALLED_GLOBALS) {
    if (key === 'window') continue;
    const value = window[key];
    if (value !== undefined) define(key, value);
  }
  // React's act() requires this flag; without it React logs a warning on every update.
  define('IS_REACT_ACT_ENVIRONMENT', true);

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
     * what a real browser does once the element has taken pointer capture.
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
     * keyboard shortcuts are the thing this harness exists to test. Pass a target
     * to aim it at an element instead.
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
        code: typeof key === 'string' && key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ...rest,
      });
      await R.act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    },

    /** Resolve after one animation frame has run. */
    nextFrame() {
      return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    },

    /**
     * Let the window's timers advance by `ms` of real time, inside act() so any
     * resulting React updates are flushed before this resolves.
     */
    async advance(ms) {
      const R = await loadReact();
      await R.act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, ms));
      });
    },

    /**
     * Give the document a non-zero layout box for one element. happy-dom has no
     * layout engine, so anything that reads geometry must be told what it is.
     */
    stubRect(element, rect) {
      const box = {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        ...rect,
      };
      element.getBoundingClientRect = () => ({ ...box, toJSON: () => box });
      return element;
    },
  };

  try {
    return await body(dom);
  } finally {
    // Unmount first so effect cleanups run against a live DOM, then close the window
    // (which aborts its pending timers and frames), then restore every global.
    try {
      if (roots.size && React) await dom.unmountAll();
    } catch {
      /* a failing cleanup must not mask the test's own error */
    }
    try {
      await window.happyDOM?.close?.();
    } catch {
      /* ditto */
    }

    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    if (savedActEnv === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnv);

    active = false;

    // Belt and braces: fail loudly if the harness (or the body) left a global behind.
    const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !globalsBefore.has(k));
    if (leaked.length) {
      throw new Error(`withDom() leaked globals: ${leaked.join(', ')}`);
    }
  }
}

/** True while a withDom() body is running. Exposed for the harness's own tests. */
export const domIsActive = () => active;

/**
 * @typedef {object} DomHarness
 * @property {import('happy-dom').Window} window
 * @property {Document} document
 * @property {HTMLElement} body
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
 * @property {() => Promise<void>} nextFrame
 * @property {(ms: number) => Promise<void>} advance
 * @property {(element: Element, rect: object) => Element} stubRect
 */
