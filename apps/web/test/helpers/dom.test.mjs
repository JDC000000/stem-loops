/**
 * Proves the DOM harness does what the interactive components need, and that it
 * cannot poison the suite.
 *
 * Every component here is a throwaway defined in this file. Nothing is imported
 * from src/components on purpose: the real mixer / transport / section-loop
 * components live on unmerged branches, and importing them would make this file
 * conflict on every one of them.
 *
 * No JSX — this is a .mjs file run directly by node:test, so React.createElement
 * is used throughout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { withDom, domIsActive } from './dom.mjs';

// Snapshot the pristine process globals at module load, BEFORE any withDom call.
// Anything that differs afterwards is a leak.
const PRISTINE_GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
const PRISTINE_NAVIGATOR = globalThis.navigator;

// ---------------------------------------------------------------------------
// 1. Opt-in: importing the helper must not create a DOM
// ---------------------------------------------------------------------------

test('importing the harness does not install a DOM', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.PointerEvent, 'undefined');
  assert.equal(domIsActive(), false);
});

test('withDom installs a DOM for the body and removes it afterwards', async () => {
  const inside = await withDom(async (dom) => {
    assert.equal(domIsActive(), true);
    assert.equal(globalThis.window, dom.window);
    assert.equal(globalThis.document, dom.document);
    assert.equal(typeof globalThis.PointerEvent, 'function');
    assert.equal(typeof globalThis.requestAnimationFrame, 'function');
    assert.equal(typeof globalThis.setPointerCaptureProbe, 'undefined');
    return 'returned-from-body';
  });

  // withDom hands back the body's return value.
  assert.equal(inside, 'returned-from-body');

  // ...and the globals are gone again.
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.PointerEvent, 'undefined');
  assert.equal(domIsActive(), false);
});

test("Node's getter-only navigator global is restored by identity, not clobbered", async () => {
  await withDom(async (dom) => {
    assert.equal(globalThis.navigator, dom.window.navigator);
    assert.notEqual(globalThis.navigator, PRISTINE_NAVIGATOR);
  });
  assert.equal(globalThis.navigator, PRISTINE_NAVIGATOR);
});

test('no global is left behind after a withDom call', async () => {
  await withDom(async () => {});
  const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !PRISTINE_GLOBALS.has(k));
  assert.deepEqual(leaked, []);
});

// ---------------------------------------------------------------------------
// 2. Pointer down/move/up WITH pointer capture, on a real React component
// ---------------------------------------------------------------------------

/**
 * A throwaway fader. Written the way real drag code is written: setPointerCapture
 * is called WITHOUT optional chaining, so if the DOM does not implement it this
 * test fails rather than silently no-opping. (It throws under jsdom — that is the
 * measured reason this harness uses happy-dom.)
 */
function Fader({ onEvent }) {
  const [value, setValue] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  return React.createElement(
    'div',
    {
      'data-testid': 'fader',
      onPointerDown: (event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onEvent({ phase: 'down', captured: event.currentTarget.hasPointerCapture(event.pointerId) });
        setDragging(true);
      },
      onPointerMove: (event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onEvent({ phase: 'move', x: event.clientX });
        setValue(event.clientX);
      },
      onPointerUp: (event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onEvent({ phase: 'up', captured: event.currentTarget.hasPointerCapture(event.pointerId) });
        setDragging(false);
      },
    },
    `value=${value} dragging=${dragging}`,
  );
}

test('a pointer down/move/up drag with pointer capture drives component state', async () => {
  await withDom(async (dom) => {
    const log = [];
    const host = await dom.mount(React.createElement(Fader, { onEvent: (e) => log.push(e) }));
    const fader = dom.find('[data-testid="fader"]');
    assert.ok(fader, 'the component mounted and is queryable');
    assert.match(host.innerHTML, /value=0 dragging=false/);

    await dom.drag(fader, [[0, 10], [32, 10], [64, 10]], { pointerId: 7 });

    assert.deepEqual(
      log.map((e) => e.phase),
      ['down', 'move', 'move', 'up'],
      'the full pointer sequence reached the component handlers',
    );
    // Capture was genuinely held during the drag and genuinely released at the end.
    assert.equal(log[0].captured, true, 'setPointerCapture took effect on pointerdown');
    assert.equal(log.at(-1).captured, false, 'releasePointerCapture took effect on pointerup');
    // The moves were only honoured because hasPointerCapture() reported true.
    assert.deepEqual(log.filter((e) => e.phase === 'move').map((e) => e.x), [32, 64]);
    assert.match(host.innerHTML, /value=64 dragging=false/, 'React re-rendered from the drag');
  });
});

test('setPointerCapture / releasePointerCapture / hasPointerCapture are real, not stubs', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    assert.equal(typeof el.setPointerCapture, 'function');
    assert.equal(typeof el.releasePointerCapture, 'function');
    assert.equal(typeof el.hasPointerCapture, 'function');
    assert.equal(el.hasPointerCapture(3), false);
    el.setPointerCapture(3);
    assert.equal(el.hasPointerCapture(3), true, 'capture state is tracked, not ignored');
    assert.equal(el.hasPointerCapture(4), false, 'tracked per pointerId');
    el.releasePointerCapture(3);
    assert.equal(el.hasPointerCapture(3), false);
  });
});

test('dom.pointer dispatches a PointerEvent carrying pointerId and coordinates', async () => {
  await withDom(async (dom) => {
    const seen = [];
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    el.addEventListener('pointerdown', (e) => {
      seen.push({ type: e.type, id: e.pointerId, x: e.clientX, y: e.clientY, kind: e.pointerType });
    });
    await dom.pointer('pointerdown', el, { pointerId: 12, clientX: 5, clientY: 9 });
    assert.deepEqual(seen, [{ type: 'pointerdown', id: 12, x: 5, y: 9, kind: 'mouse' }]);
  });
});

// ---------------------------------------------------------------------------
// 3. A window-level keydown listener registered in an effect
// ---------------------------------------------------------------------------

/** Throwaway transport: a window keydown shortcut, the way a real one is wired. */
function Transport() {
  const [keys, setKeys] = React.useState([]);
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === ' ' || event.key === 'k') setKeys((prev) => [...prev, event.key]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return React.createElement('div', { 'data-testid': 'transport' }, `keys=${keys.join(',')}`);
}

test("a component's window keydown listener receives dispatched keys", async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Transport));
    const shown = () => dom.find('[data-testid="transport"]').textContent;
    assert.equal(shown(), 'keys=');

    await dom.keydown(' ');
    assert.equal(shown(), 'keys= ', 'space reached the window listener');

    await dom.keydown('k');
    assert.equal(shown(), 'keys= ,k', 'a second key appended');

    await dom.keydown('q');
    assert.equal(shown(), 'keys= ,k', 'an unhandled key changed nothing');
  });
});

test('a keydown on an element bubbles up to the window listener', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Transport));
    const target = dom.find('[data-testid="transport"]');
    await dom.keydown('k', { target });
    assert.equal(target.textContent, 'keys=k');
  });
});

test('the window keydown listener is gone after unmount', async () => {
  await withDom(async (dom) => {
    const host = await dom.mount(React.createElement(Transport));
    await dom.keydown('k');
    assert.equal(dom.find('[data-testid="transport"]').textContent, 'keys=k');

    await dom.unmountAll();
    assert.equal(host.innerHTML, '', 'React removed the tree');
    assert.equal(dom.find('[data-testid="transport"]'), null);

    // If the effect cleanup had not removed the listener, this keydown would call
    // setState on an unmounted root.
    await dom.keydown('k');
    assert.equal(host.innerHTML, '');
  });
});

// ---------------------------------------------------------------------------
// 4. Effects: run on mount, clean up on unmount, including timers and frames
// ---------------------------------------------------------------------------

function Lifecycle({ log }) {
  const [phase, setPhase] = React.useState('initial');
  React.useEffect(() => {
    log.push('effect:run');
    const timer = setTimeout(() => {
      log.push('timer:fired');
      setPhase('after-timer');
    }, 20);
    return () => {
      log.push('effect:cleanup');
      clearTimeout(timer);
    };
  }, []);
  return React.createElement('div', { 'data-testid': 'lifecycle' }, `phase=${phase}`);
}

test('an effect runs on mount and its cleanup runs on unmount', async () => {
  await withDom(async (dom) => {
    const log = [];
    const host = await dom.mount(React.createElement(Lifecycle, { log }));
    assert.deepEqual(log, ['effect:run'], 'the effect ran during mount');
    assert.match(host.innerHTML, /phase=initial/);

    await dom.unmountAll();
    assert.deepEqual(log, ['effect:run', 'effect:cleanup'], 'the cleanup ran on unmount');
  });
});

test('a timer started inside an effect fires and updates React state', async () => {
  await withDom(async (dom) => {
    const log = [];
    const host = await dom.mount(React.createElement(Lifecycle, { log }));
    assert.match(host.innerHTML, /phase=initial/);

    await dom.advance(40);

    assert.ok(log.includes('timer:fired'), 'the effect timer fired');
    assert.match(host.innerHTML, /phase=after-timer/, 'the timer update was flushed');
  });
});

test('effect cleanup runs at teardown even if the test forgets to unmount', async () => {
  const log = [];
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Lifecycle, { log }));
    assert.deepEqual(log, ['effect:run']);
    // deliberately no unmountAll()
  });
  assert.deepEqual(log, ['effect:run', 'effect:cleanup'], 'teardown unmounted the root for us');
});

/** One rAF, then a state update: the shape of a "measure after paint" effect. */
function OneFrame({ log }) {
  const [painted, setPainted] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => {
      log.push('raf');
      setPainted(true);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return React.createElement('div', { 'data-testid': 'one-frame' }, `painted=${painted}`);
}

test('requestAnimationFrame fires and its state update is flushed', async () => {
  await withDom(async (dom) => {
    const log = [];
    await dom.mount(React.createElement(OneFrame, { log }));
    const shown = () => dom.find('[data-testid="one-frame"]').textContent;

    // Note: mount()'s act() awaits, which can already let a pending frame run, so
    // the value here is deliberately not asserted — only the post-frame value is.
    await dom.act(() => dom.nextFrame());

    assert.deepEqual(log, ['raf'], 'the rAF callback ran exactly once');
    assert.equal(shown(), 'painted=true', 'and its setState was flushed into the DOM');
  });
});

/**
 * A continuous rAF loop, as a playhead or level meter would run one. It logs frames
 * instead of calling setState on every frame — see "WHAT THIS HARNESS STILL CANNOT DO"
 * in dom.mjs: an unbounded rAF -> setState loop never lets act() reach quiescence.
 */
function FrameLoop({ log }) {
  React.useEffect(() => {
    let id = requestAnimationFrame(function tick() {
      log.push('frame');
      id = requestAnimationFrame(tick);
    });
    return () => {
      log.push('cancelled');
      cancelAnimationFrame(id);
    };
  }, []);
  return React.createElement('div', null, 'loop');
}

test('cancelAnimationFrame in an effect cleanup actually stops a running rAF loop', async () => {
  await withDom(async (dom) => {
    const log = [];
    await dom.mount(React.createElement(FrameLoop, { log }));

    await dom.nextFrame();
    await dom.nextFrame();
    const framesWhileMounted = log.filter((e) => e === 'frame').length;
    assert.ok(framesWhileMounted >= 1, `the loop ran while mounted (${framesWhileMounted} frames)`);

    await dom.unmountAll();
    assert.ok(log.includes('cancelled'), 'the cleanup ran');

    const atUnmount = log.filter((e) => e === 'frame').length;
    // Real elapsed time, deliberately: if cancelAnimationFrame were a no-op the loop
    // would keep ticking here and bleed frames into the next test.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      log.filter((e) => e === 'frame').length,
      atUnmount,
      'no frames ran after unmount',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Isolation: a test that pollutes the DOM must not affect the next
// ---------------------------------------------------------------------------

/** Bumped by a listener registered in the polluting test. Must never move again. */
let pollutingListenerHits = 0;

test('[polluter] scribbles on window, document and the global key listener', async () => {
  await withDom(async (dom) => {
    dom.window.__harnessPollution = 'polluted';
    dom.window.localStorage.setItem('harness-pollution', 'yes');
    dom.document.body.setAttribute('data-polluted', 'yes');
    dom.document.body.appendChild(dom.document.createElement('section'));
    dom.window.addEventListener('keydown', () => { pollutingListenerHits += 1; });

    await dom.keydown('x');
    assert.equal(pollutingListenerHits, 1, 'the polluter\'s own listener does fire inside its own test');
    assert.equal(dom.window.__harnessPollution, 'polluted');
  });

  // The polluted window never escapes to globalThis.
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.localStorage, 'undefined');
});

test('[victim] sees a pristine DOM, and the polluter\'s listener is dead', async () => {
  const hitsBefore = pollutingListenerHits;
  await withDom(async (dom) => {
    assert.equal(dom.window.__harnessPollution, undefined, 'window properties did not carry over');
    assert.equal(dom.window.localStorage.getItem('harness-pollution'), null, 'localStorage did not carry over');
    assert.equal(dom.document.body.getAttribute('data-polluted'), null, 'body attributes did not carry over');
    assert.equal(dom.document.body.children.length, 0, 'the body is empty again');

    await dom.keydown('x');
    assert.equal(
      pollutingListenerHits,
      hitsBefore,
      "the previous test's window listener did not receive this test's keydown",
    );
  });
});

test('each withDom call gets a distinct window and document', async () => {
  const first = await withDom(async (dom) => ({ win: dom.window, doc: dom.document }));
  const second = await withDom(async (dom) => ({ win: dom.window, doc: dom.document }));
  assert.notEqual(first.win, second.win);
  assert.notEqual(first.doc, second.doc);
});

// ---------------------------------------------------------------------------
// 6. The harness fails safe
// ---------------------------------------------------------------------------

test('a throwing body still tears the DOM down', async () => {
  await assert.rejects(
    withDom(async (dom) => {
      await dom.mount(React.createElement(Transport));
      throw new Error('boom from the test body');
    }),
    /boom from the test body/,
  );
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(domIsActive(), false);
  const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !PRISTINE_GLOBALS.has(k));
  assert.deepEqual(leaked, []);
});

test('nested withDom is refused, and the outer call still tears down', async () => {
  await withDom(async () => {
    await assert.rejects(withDom(async () => {}), /already active/);
    assert.equal(typeof globalThis.window, 'object', 'the outer DOM survived the refusal');
  });
  assert.equal(domIsActive(), false);
  assert.equal(typeof globalThis.window, 'undefined');
});

test('stubRect supplies the geometry happy-dom has no layout engine for', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    assert.equal(el.getBoundingClientRect().width, 0, 'no layout engine: everything is zero');

    dom.stubRect(el, { left: 100, width: 200, top: 0, height: 20 });
    const rect = el.getBoundingClientRect();
    assert.equal(rect.left, 100);
    assert.equal(rect.width, 200);
  });
});

test('drag() rejects an empty point list rather than silently doing nothing', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    await assert.rejects(dom.drag(el, []), /at least one/);
  });
});
