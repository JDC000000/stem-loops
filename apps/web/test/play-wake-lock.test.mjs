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

test('Player holds it for as long as the player is mounted, playing or paused (Phase A)', () => {
  const src = readFileSync(join(WEB, 'src/components/play/Player.tsx'), 'utf8');
  assert.match(src, /const lock = createWakeLock\(globalThis\.navigator, globalThis\.document\);\s*lock\.set\(true\);\s*return \(\) => lock\.dispose\(\);\s*\}, \[\]\);/);
  // Never tied to the play state again (a pause must not let the screen dim).
  assert.doesNotMatch(src, /\.set\(playing\)/);
});

test('held across a pause: only hiding the page lets it go, and showing it takes it back', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true); // the player mounts
  await tick();
  assert.equal(f.live(), 1);
  // Hidden (tab switch, screen off): released by us at once, not left to the browser.
  f.doc.visibilityState = 'hidden';
  f.doc.fire();
  await tick();
  assert.equal(f.live(), 0);
  assert.ok(f.log.includes('release'), 'released on visibilitychange hidden');
  f.doc.visibilityState = 'visible';
  f.doc.fire();
  await tick();
  assert.equal(f.live(), 1, 'taken back when visible');
  assert.equal(f.log.filter((l) => l === 'request:screen').length, 2);
  lock.dispose();
  await tick();
  assert.equal(f.live(), 0);
});

test('review #333 L-2: a lock granted after the page went hidden is given straight back', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true); // request in flight...
  f.doc.visibilityState = 'hidden'; // ...the page hides before it resolves
  await tick();
  assert.equal(f.live(), 0, 'not kept while hidden');
  f.doc.visibilityState = 'visible';
  f.doc.fire();
  await tick();
  assert.equal(f.live(), 1, 'taken again when visible');
  lock.dispose();
  await tick();
});

test('review #333 L-2: a lock the browser drops while the page is visible is taken back', async () => {
  const f = fakes();
  const lock = createWakeLock(f.nav, f.doc);
  lock.set(true);
  await tick();
  f.sentinels[0].drop(); // e.g. battery saver; the page is still visible
  await tick();
  assert.equal(f.live(), 1, 're-acquired');
  assert.equal(f.log.filter((l) => l === 'request:screen').length, 2);
  // Our own release (pause / unmount) never re-acquires.
  lock.dispose();
  await tick();
  assert.equal(f.live(), 0);
});
