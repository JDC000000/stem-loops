// Screen Wake Lock while playing (design v1.4, P1.2): src/lib/play/wake-lock.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWakeLock, wakeLockSupported } from '../src/lib/play/wake-lock.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakes({ refuse = false } = {}) {
  const log = [];
  let live = 0;
  const sentinels = [];
  const nav = {
    wakeLock: {
      async request(type) {
        log.push(`request:${type}`);
        if (refuse) throw new Error('NotAllowedError');
        const listeners = [];
        const s = {
          released: false,
          async release() { if (!s.released) { s.released = true; live--; log.push('release'); listeners.forEach((f) => f()); } },
          addEventListener(_t, f) { listeners.push(f); },
          drop() { s.released = true; live--; listeners.forEach((f) => f()); }, // the browser drops it (page hidden)
        };
        live++;
        sentinels.push(s);
        return s;
      },
    },
  };
  const handlers = new Set();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_t, f) => handlers.add(f),
    removeEventListener: (_t, f) => handlers.delete(f),
    fire() { handlers.forEach((f) => f()); },
  };
  return { nav, doc, log, sentinels, live: () => live, handlers };
}

test('held while playing, released on pause; idempotent', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true);
  lock.set(true);
  await tick();
  assert.equal(f.live(), 1);
  assert.deepEqual(f.log, ['request:screen']);
  lock.set(false);
  await tick();
  assert.equal(f.live(), 0);
  lock.dispose();
});

test('re-acquired when the page is visible again (the browser drops it when hidden)', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true);
  await tick();
  f.doc.visibilityState = 'hidden';
  f.sentinels[0].drop();
  f.doc.fire();
  await tick();
  assert.equal(f.live(), 0, 'not requested while hidden');
  f.doc.visibilityState = 'visible';
  f.doc.fire();
  await tick();
  assert.equal(f.live(), 1);
  lock.dispose();
  await tick();
  assert.equal(f.live(), 0);
  assert.equal(f.handlers.size, 0, 'dispose removes the listener');
});

test('paused before the request resolves: the late lock is released at once', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true);
  lock.set(false);
  await tick();
  await tick();
  assert.equal(f.live(), 0);
});

test('feature-detected: no API, or a refused request, breaks nothing', async () => {
  assert.equal(wakeLockSupported({}), false);
  assert.equal(wakeLockSupported(null), false);
  const none = createWakeLock({}, null);
  assert.doesNotThrow(() => { none.set(true); none.set(false); none.dispose(); });
  const f = fakes({ refuse: true });
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true);
  await tick();
  assert.equal(f.live(), 0);
  lock.dispose();
});

test('Player wires it to the playing state (and only that)', () => {
  const src = readFileSync(join(WEB, 'src/components/play/Player.tsx'), 'utf8');
  assert.match(src, /createWakeLock\(globalThis\.navigator, globalThis\.document\)/);
  assert.match(src, /const playing = snapshot\.status === 'playing';\s*useEffect\(\(\) => \{\s*wakeRef\.current\?\.set\(playing\);\s*\}, \[playing\]\);/);
  assert.match(src, /lock\.dispose\(\)/);
});
