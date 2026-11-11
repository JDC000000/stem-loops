/**
 * Proves the DOM harness does what the interactive components need, and — the part
 * that actually matters for a helper every later test builds on — that it cannot
 * turn a red test green or poison the test that follows it.
 *
 * Every component here is a throwaway defined in this file, so this file does not
 * couple to any component's current shape.
 *
 * No JSX — this is a .mjs file run directly by node:test, so React.createElement
 * is used throughout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React from 'react';

import { withDom, domIsActive, codeForKey } from './dom.mjs';

const HARNESS = fileURLToPath(new URL('./dom.mjs', import.meta.url));

// Snapshot the pristine process globals at module load, BEFORE any withDom call.
const PRISTINE_GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
const PRISTINE_NAVIGATOR = globalThis.navigator;
// Captured by identity: never *called*, since calling real fetch with no URL rejects.
const PRISTINE_FETCH = globalThis.fetch;

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
    return 'returned-from-body';
  });

  assert.equal(inside, 'returned-from-body');
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
    assert.equal(log[0].captured, true, 'setPointerCapture took effect on pointerdown');
    assert.equal(log.at(-1).captured, false, 'releasePointerCapture took effect on pointerup');
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

/**
 * Throwaway transport. Reads `event.code`, the way a play/pause shortcut is normally
 * written — a harness that reports `code === 'Key '` for the spacebar would make a
 * correct component look broken.
 */
function Transport() {
  const [log, setLog] = React.useState([]);
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code === 'Space') setLog((prev) => [...prev, 'toggle']);
      else if (event.code === 'Digit1') setLog((prev) => [...prev, 'cue1']);
      else if (event.code === 'KeyK') setLog((prev) => [...prev, 'k']);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return React.createElement('div', { 'data-testid': 'transport' }, `log=${log.join(',')}`);
}

test('codeForKey maps keys to the codes a browser would report', () => {
  assert.equal(codeForKey(' '), 'Space', 'the spacebar is Space, not "Key "');
  assert.equal(codeForKey('1'), 'Digit1', 'digits are DigitN, not KeyN');
  assert.equal(codeForKey('k'), 'KeyK');
  assert.equal(codeForKey('K'), 'KeyK');
  assert.equal(codeForKey('ArrowLeft'), 'ArrowLeft');
  assert.equal(codeForKey('Enter'), 'Enter');
  assert.equal(codeForKey('/'), 'Slash');
  assert.equal(codeForKey('.'), 'Period');
});

test("a component's window keydown listener receives dispatched keys with browser codes", async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Transport));
    const shown = () => dom.find('[data-testid="transport"]').textContent;
    assert.equal(shown(), 'log=');

    // The transport's play/pause key. This is the case that was silently broken.
    await dom.keydown(' ');
    assert.equal(shown(), 'log=toggle', 'space arrived with code === "Space"');

    await dom.keydown('1');
    assert.equal(shown(), 'log=toggle,cue1', 'the digit arrived with code === "Digit1"');

    await dom.keydown('k');
    assert.equal(shown(), 'log=toggle,cue1,k');

    await dom.keydown('q');
    assert.equal(shown(), 'log=toggle,cue1,k', 'an unhandled key changed nothing');
  });
});

test('an explicit code in the init overrides the derived one', async () => {
  await withDom(async (dom) => {
    const codes = [];
    dom.window.addEventListener('keydown', (e) => codes.push(e.code));
    await dom.keydown('x', { code: 'F13' });
    assert.deepEqual(codes, ['F13']);
  });
});

test('a keydown on an element bubbles up to the window listener', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Transport));
    const target = dom.find('[data-testid="transport"]');
    await dom.keydown(' ', { target });
    assert.equal(target.textContent, 'log=toggle');
  });
});

test('the window keydown listener is gone after unmount', async () => {
  await withDom(async (dom) => {
    const host = await dom.mount(React.createElement(Transport));
    await dom.keydown(' ');
    assert.equal(dom.find('[data-testid="transport"]').textContent, 'log=toggle');

    await dom.unmountAll();
    assert.equal(host.innerHTML, '', 'React removed the tree');
    assert.equal(dom.find('[data-testid="transport"]'), null);

    // If the effect cleanup had not removed the listener, this keydown would call
    // setState on an unmounted root.
    await dom.keydown(' ');
    assert.equal(host.innerHTML, '');
  });
});

// ---------------------------------------------------------------------------
// 4. Effects: run on mount, clean up on unmount, including timers
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

// ---------------------------------------------------------------------------
// 5. Animation frames: the controlled clock, and the playhead that used to hang
// ---------------------------------------------------------------------------

/**
 * The shape the transport playhead has: rAF -> setState -> rAF, forever. Under
 * happy-dom's own timer-driven rAF this cannot even be mounted — act() never reaches
 * quiescence and mount() hangs. The controlled frame clock is what makes it testable.
 */
function Playhead() {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    let id = requestAnimationFrame(function tick() {
      setFrame((n) => n + 1);
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return React.createElement('div', { 'data-testid': 'playhead' }, `frame=${frame}`);
}

test('a continuous rAF -> setState playhead mounts and advances one frame at a time', async () => {
  await withDom(async (dom) => {
    // Mounting at all is the fix: this is the case that used to hang forever.
    await dom.mount(React.createElement(Playhead));
    const shown = () => dom.find('[data-testid="playhead"]').textContent;

    assert.equal(shown(), 'frame=0', 'no frame has run yet — frames are manual');
    assert.equal(dom.pendingFrames, 1, 'the effect scheduled exactly one frame');

    assert.equal(await dom.nextFrame(), 1, 'one callback ran');
    assert.equal(shown(), 'frame=1');
    assert.equal(dom.pendingFrames, 1, 'the loop re-scheduled itself for the next frame');

    await dom.frames(3);
    assert.equal(shown(), 'frame=4', 'the playhead advanced deterministically');
  });
});

test('cancelAnimationFrame in an effect cleanup stops the loop', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Playhead));
    await dom.frames(2);
    assert.equal(dom.find('[data-testid="playhead"]').textContent, 'frame=2');
    assert.equal(dom.pendingFrames, 1);

    await dom.unmountAll();

    assert.equal(dom.pendingFrames, 0, 'the cleanup cancelled the queued frame');
    assert.equal(await dom.nextFrame(), 0, 'and no callback runs afterwards');
  });
});

test('a one-shot rAF fires and its state update is flushed', async () => {
  await withDom(async (dom) => {
    const log = [];
    function OneFrame() {
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
    await dom.mount(React.createElement(OneFrame));
    assert.equal(dom.find('[data-testid="one-frame"]').textContent, 'painted=false');

    await dom.nextFrame();

    assert.deepEqual(log, ['raf'], 'the rAF callback ran exactly once');
    assert.equal(dom.find('[data-testid="one-frame"]').textContent, 'painted=true');
  });
});

test('realFrames: true restores happy-dom timer-driven frames', async () => {
  await withDom(async (dom) => {
    let fired = false;
    await dom.act(() => new Promise((resolve) => {
      dom.window.requestAnimationFrame(() => { fired = true; resolve(); });
    }));
    assert.equal(fired, true, 'the frame fired on its own, without nextFrame()');
  }, { realFrames: true });
});

// ---------------------------------------------------------------------------
// 6. Isolation: pollution must not reach the next test — additions AND changes
// ---------------------------------------------------------------------------

/** Bumped by a listener registered in the polluting test. Must never move again. */
let pollutingListenerHits = 0;

test('[polluter] scribbles on window, document, globals and a shared DOM prototype', async () => {
  // Every one of these is detected and reverted at teardown, so withDom rejects —
  // which is the point: pollution fails the test that caused it, not a later one.
  await assert.rejects(
    withDom(async (dom) => {
      dom.window.__harnessPollution = 'polluted';
      dom.window.localStorage.setItem('harness-pollution', 'yes');
      dom.document.body.setAttribute('data-polluted', 'yes');
      dom.document.body.appendChild(dom.document.createElement('section'));
      dom.window.addEventListener('keydown', () => { pollutingListenerHits += 1; });

      await dom.keydown(' ');
      assert.equal(pollutingListenerHits, 1, "the polluter's own listener fires inside its own test");

      // An added global, a MODIFIED existing global, and prototype pollution of a
      // class happy-dom shares between windows.
      globalThis.__harnessAddedGlobal = 'added';
      globalThis.fetch = () => 'HIJACKED';
      dom.window.Element.prototype.__harnessProtoLeak = 'leaked';
    }),
    (error) => {
      assert.match(error.message, /globalThis\.__harnessAddedGlobal was added/);
      assert.match(error.message, /globalThis\.fetch was modified/);
      assert.match(error.message, /Element\.prototype\.__harnessProtoLeak was added/);
      return true;
    },
  );

  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.localStorage, 'undefined');
});

test('[victim] sees a pristine DOM and pristine globals', async () => {
  const hitsBefore = pollutingListenerHits;
  await withDom(async (dom) => {
    assert.equal(dom.window.__harnessPollution, undefined, 'window properties did not carry over');
    assert.equal(dom.window.localStorage.getItem('harness-pollution'), null, 'localStorage did not carry over');
    assert.equal(dom.document.body.getAttribute('data-polluted'), null, 'body attributes did not carry over');
    assert.equal(dom.document.body.children.length, 0, 'the body is empty again');

    // The reverted global modification, and the reverted prototype pollution. Without
    // the descriptor-level revert, a stubbed fetch would still be live here and every
    // element in this "fresh" window would carry __harnessProtoLeak.
    assert.equal(globalThis.fetch, PRISTINE_FETCH, 'the hijacked fetch was reverted by identity');
    assert.equal(globalThis.__harnessAddedGlobal, undefined);
    assert.equal(dom.document.createElement('div').__harnessProtoLeak, undefined);

    await dom.keydown(' ');
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
// 7. The harness fails safe — it must never turn a red test green, or wedge
// ---------------------------------------------------------------------------

test("a throwing body reaches the caller unchanged, even when teardown also complains", async () => {
  await assert.rejects(
    withDom(async (dom) => {
      await dom.mount(React.createElement(Transport));
      globalThis.__alsoLeaked = 'yes';
      throw new Error('THE REAL FAILURE');
    }),
    (error) => {
      // The body's error is the headline. Before the fix the caller saw only
      // "withDom() leaked globals: __alsoLeaked" and the real failure vanished.
      assert.equal(error.message, 'THE REAL FAILURE');
      assert.match(String(error.cause?.message), /__alsoLeaked was added/);
      return true;
    },
  );
  assert.equal(globalThis.__alsoLeaked, undefined, 'and the leak was still reverted');
  assert.equal(domIsActive(), false);
});

test('a throwing React effect cleanup at teardown fails the test instead of being swallowed', async () => {
  // This is the shape this codebase will have: `() => audioCtx.close()` where
  // audioCtx is null. Previously the test reported pass.
  await assert.rejects(
    withDom(async (dom) => {
      function Boom() {
        React.useEffect(() => () => {
          throw new Error('audioCtx.close() of null');
        }, []);
        return React.createElement('div', null, 'boom');
      }
      await dom.mount(React.createElement(Boom));
    }),
    /effect cleanup threw during teardown: audioCtx\.close\(\) of null/,
  );
  assert.equal(domIsActive(), false);
});

test('a teardown that reports problems still clears the active flag', async () => {
  await assert.rejects(withDom(async () => { globalThis.__wedge = 1; }), /__wedge was added/);
  assert.equal(domIsActive(), false, 'active was cleared despite the teardown throwing');
  // The real regression: the NEXT withDom in the same file must still work.
  assert.equal(await withDom(async () => 'still works'), 'still works');
});

test('an unrestorable global does not wedge the harness for the rest of the process', () => {
  // Making a global non-configurable is irreversible by nature, so this runs in its
  // own process: the point is that `active` is cleared and the next call proceeds,
  // rather than every later call rejecting with a misleading "already active".
  const script = `
    import { withDom, domIsActive } from ${JSON.stringify(HARNESS)};
    let first = 'no-throw';
    try {
      await withDom(async () => {
        Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: false });
      });
    } catch (e) { first = e.message; }
    console.log('active=' + domIsActive());
    console.log('namesRealCause=' + /localStorage/.test(first));
    console.log('blamesNesting=' + /already active/.test(first));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
  });
  // Anchored: an unanchored /active=false/ also matches inside "blamesNesting=false".
  assert.match(out, /^active=false$/m, 'the active flag was cleared');
  assert.match(out, /^namesRealCause=true$/m, 'the error names the real cause');
  assert.match(out, /^blamesNesting=false$/m, 'and does not blame nesting');
});

test('nested withDom is refused, and the outer call still tears down', async () => {
  await withDom(async () => {
    await assert.rejects(withDom(async () => {}), /already active/);
    assert.equal(typeof globalThis.window, 'object', 'the outer DOM survived the refusal');
  });
  assert.equal(domIsActive(), false);
  assert.equal(typeof globalThis.window, 'undefined');
});

// ---------------------------------------------------------------------------
// 8. Layout: absent, and stubbed honestly
// ---------------------------------------------------------------------------

test('every box metric is 0 — there is no layout engine', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    el.style.width = '360px';
    dom.document.body.appendChild(el);

    assert.equal(el.getBoundingClientRect().width, 0);
    assert.equal(el.offsetWidth, 0);
    assert.equal(el.clientWidth, 0);
    assert.equal(el.scrollWidth, 0);

    // The trap worth knowing about: computed style reports the DECLARED value, so a
    // test can read 360px here and wrongly believe layout happened.
    assert.equal(dom.window.getComputedStyle(el).width, '360px');
  });
});

test('stubRect supplies the rect AND the box metrics, including an overflow case', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);

    dom.stubRect(el, { left: 100, top: 0, width: 200, height: 20 });
    const rect = el.getBoundingClientRect();
    assert.equal(rect.left, 100);
    assert.equal(rect.width, 200);
    assert.equal(rect.right, 300, 'right is derived from left + width');
    assert.equal(el.offsetWidth, 200, 'the box metrics follow the rect');
    assert.equal(el.clientWidth, 200);
    assert.equal(el.scrollWidth, 200);

    // Diverging the metrics is how an overflow is expressed: content wider than box.
    const track = dom.document.createElement('div');
    dom.document.body.appendChild(track);
    dom.stubRect(track, { width: 334, height: 44, metrics: { scrollWidth: 347 } });
    assert.equal(track.clientWidth, 334);
    assert.equal(track.scrollWidth, 347);
    assert.ok(track.scrollWidth > track.clientWidth, 'an overflow case is now expressible');
  });
});

test('drag() rejects an empty point list rather than silently doing nothing', async () => {
  await withDom(async (dom) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    await assert.rejects(dom.drag(el, []), /at least one/);
  });
});
