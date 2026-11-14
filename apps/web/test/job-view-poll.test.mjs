// /jobs/[id] — THE POLLING EFFECT, MOUNTED AND DRIVEN.
//
// WHY THIS FILE EXISTS. `test/job-page-render.test.mjs` renders the real
// JobView but seeds `useState` positionally and shims `useEffect` to a no-op:
// it proves what each state RENDERS AS and nothing about how a state is
// REACHED. Review used that gap: mutations that gutted the effect body — never
// show the unreachable panel, reset the failure count on every poll, fire
// `unreachable` only on a literal 500 — survived the entire suite, because
// `poll()` is never executed anywhere in it.
//
// Here the real effect runs: real React, real `job-poll.ts`, a stubbed `fetch`
// and a VIRTUAL CLOCK, so a 95-minute scenario costs microseconds and every
// assertion is about what the user would actually see on the page.
//
// THE TWO REGRESSIONS THIS FILE PINS. Review measured both against the base
// branch, which did neither:
//   R2  a job queued behind another, stalled at the threshold and finishing
//       later: the page said "nothing has picked it up" and STOPPED POLLING
//       (fetch count frozen), so the finished track never appeared.
//   R3  five 500s then recovery: the page sat on "We can't get an update" until
//       the user clicked, where the previous version self-healed.
// Both are now "panel, not stop". A test that only asserts the panel appears
// cannot see either; every scenario below therefore keeps driving the clock
// PAST the panel and asserts on what happens next.
//
// WHAT THIS CANNOT COVER, per test/helpers/dom.mjs: layout, and real network
// semantics. The `fetch` here is a stub; CORS, redirects and streaming are not
// exercised. `readPoll`'s handling of real `Response` objects is covered in
// test/job-poll.test.mjs, which uses the real class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'job-view-poll-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

// ─── the module graph: everything EXCEPT the effect is a stub ────────────────
// `react` and `@/lib/job-poll` are the real ones. A stub of either would test
// the stub; the policy and the hook wiring are exactly what is under test.

const playerMod = put(
  'Player.mjs',
  `import { createElement } from 'react';
   export default function Player(props) {
     return createElement('div', { 'data-testid': 'player', 'data-job-id': String(props.jobId) });
   }`,
);
const loopResultsMod = put(
  'LoopResults.mjs',
  `import { createElement } from 'react';
   export function LoopResults() { return createElement('div', { 'data-testid': 'loop-results' }); }
   export default LoopResults;`,
);
const jobProgressMod = put(
  'JobProgress.mjs',
  `import { createElement } from 'react';
   export function JobProgress(props) {
     return createElement('div', { 'data-testid': 'job-progress', 'data-status': String(props.job?.status) });
   }
   export default JobProgress;`,
);
const linkMod = put(
  'next-link.mjs',
  `import { createElement } from 'react';
   export default function Link({ href, children, ...rest }) {
     return createElement('a', { href: String(href), ...rest }, children);
   }`,
);
const retentionMod = put('retention.mjs', `export const formatExpiresIn = () => 'in 24 hours';`);
const chordOverlayMod = put(
  'ChordOverlay.mjs',
  `import { createElement } from 'react';
   export const ChordOverlay = () => createElement('div', { 'data-testid': 'chord-overlay' });
   export default ChordOverlay;`,
);
const jobPollMod = put('job-poll.mjs', toJs(read('src/lib/job-poll.ts')));
const errorCopyMod = put('error-copy.mjs', toJs(read('src/lib/error-copy.ts')));

const jobViewJs = toJs(read('src/app/jobs/[id]/JobView.tsx'))
  .replace(/from ['"]@\/components\/play\/Player['"]/g, `from '${playerMod}'`)
  .replace(/from ['"]@\/components\/LoopResults['"]/g, `from '${loopResultsMod}'`)
  .replace(/from ['"]@\/components\/JobProgress['"]/g, `from '${jobProgressMod}'`)
  .replace(/from ['"]next\/link['"]/g, `from '${linkMod}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionMod}'`)
  .replace(/from ['"]@\/lib\/job-poll['"]/g, `from '${jobPollMod}'`)
  .replace(/from ['"]@\/lib\/error-copy['"]/g, `from '${errorCopyMod}'`)
  .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordOverlayMod}'`);
writeFileSync(join(dir, 'JobView.mjs'), jobViewJs);

// Any specifier left unstubbed crashes the FILE at import, which node:test
// reports as `not ok 1 - test/job-view-poll.test.mjs` — indistinguishable from
// a kill while meaning the opposite. Named, so it cannot be mistaken.
const UNRESOLVED = [...jobViewJs.matchAll(/from ['"]([^'"]+)['"]/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('.'))
  .filter((spec) => spec !== 'react' && spec !== 'react/jsx-runtime');

const React = (await import('react')).default;
const JobView = (await import(pathToFileURL(join(dir, 'JobView.mjs')).href)).default;
const { MAX_CONSECUTIVE_FAILURES, POLL_MS, BACKOFF_POLL_MS, SLOW_POLL_MS, QUEUED_STALL_MS } =
  await import(pathToFileURL(join(dir, 'job-poll.mjs')).href);

// ─── the stubbed server ──────────────────────────────────────────────────────
// Installed on globalThis ONCE, before any withDom() call, so the harness's own
// post-install global snapshot contains it and teardown sees no drift. Each
// test swaps `answer`, never the property.

const SERVER_NOW = Date.parse('2026-11-12T12:00:00Z');
let answer = () => ({ status: 500 });
let fetches = [];
/** Virtual milliseconds since mount, for `date` headers that move with the clock. */
let clockRef = { now: 0 };

const OK_HEADERS = (offsetMs) => ({
  get: (k) => (String(k).toLowerCase() === 'date' ? new Date(SERVER_NOW + offsetMs).toUTCString() : null),
});

globalThis.fetch = async (url) => {
  const n = fetches.length + 1;
  fetches.push(String(url));
  const a = answer(n, clockRef.now);
  if (a instanceof Error) throw a;
  const status = a.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: OK_HEADERS(clockRef.now),
    json: async () => {
      if (a.badJson) throw new SyntaxError('Unexpected token');
      return a.body ?? { error_code: 'INTERNAL_ERROR', message: 'boom' };
    },
  };
};

/** A job as the route would return it, `updated_at` fixed at mount time. */
const job = (status, over = {}) => ({
  id: 'job-poll-1',
  status,
  original_filename: 'slow.mp3',
  youtube_url: null,
  error_message_user: null,
  expires_at: null,
  updated_at: new Date(SERVER_NOW).toISOString(),
  events: [],
  loops: [],
  ...over,
});

// ─── the virtual clock ───────────────────────────────────────────────────────
// `dom.advance()` burns REAL time, so a 95-minute scenario is not reachable
// through it. This replaces the window's setTimeout for the duration of one
// body and restores it, so `JobView`'s own `setTimeout(poll, …)` lands in a
// queue the test drives. React is loaded BEFORE the swap (see `start`), because
// the scheduler captures `setTimeout` at module evaluation.

function makeClock() {
  let seq = 0;
  const queue = new Map();
  const ref = { now: 0 };
  return {
    ref,
    set(fn, ms) {
      const id = ++seq;
      queue.set(id, { at: ref.now + (Number(ms) || 0), fn });
      return id;
    },
    clear(id) {
      queue.delete(id);
    },
    get pending() {
      return queue.size;
    },
    /** Run every callback due within `ms`, in time order, flushing React between. */
    async advance(dom, ms, settle) {
      const target = ref.now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of queue) if (!next || t.at < next[1].at) next = [id, t];
        if (!next || next[1].at > target) break;
        ref.now = next[1].at;
        queue.delete(next[0]);
        // `poll` is async; awaiting it, then draining on a real macrotask, is
        // what makes a scenario deterministic instead of racing the next step.
        await dom.act(async () => {
          await next[1].fn();
        });
        await settle();
      }
      ref.now = target;
    },
  };
}

/**
 * Mount JobView under a virtual clock and hand the body a driver.
 *
 * `serve` is the stubbed server and is REQUIRED UP FRONT, because the effect
 * fires its first `fetch` during mount: a test that set it inside the body
 * would be asserting against whatever the previous test left behind.
 */
async function drive(serve, body) {
  return withDom(async (dom) => {
    // Load React (and the scheduler, which captures `setTimeout` at module
    // evaluation) while the REAL timers are still installed.
    await dom.act(() => {});

    const clock = makeClock();
    clockRef = clock.ref;
    fetches = [];
    answer = serve;

    const savedSet = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const savedClear = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
    const realSetTimeout = savedSet.value;
    /**
     * Yield a real macrotask inside act(), which drains every microtask the
     * poll chain is sitting on (`fetch` -> `res.json()` -> `setState`). Without
     * it the first poll has not finished when the test looks, so its
     * `setTimeout` is not in the queue yet and `advance()` finds nothing to do.
     */
    const settle = () => dom.act(() => new Promise((r) => realSetTimeout(r, 0)));

    Object.defineProperty(globalThis, 'setTimeout', { ...savedSet, value: (fn, ms) => clock.set(fn, ms) });
    Object.defineProperty(globalThis, 'clearTimeout', { ...savedClear, value: (id) => clock.clear(id) });
    try {
      const host = await dom.mount(React.createElement(JobView, { id: 'job-poll-1' }));
      await settle();
      const api = {
        dom,
        host,
        clock,
        /** Swap the stubbed server mid-scenario (a backend recovering, a job finishing). */
        serve: (fn) => {
          answer = fn;
        },
        text: () => host.textContent ?? '',
        has: (sel) => dom.find(sel) !== null,
        get fetchCount() {
          return fetches.length;
        },
        advance: (ms) => clock.advance(dom, ms, settle),
        click: async (sel) => {
          const el = dom.find(sel);
          assert.ok(el, `no element matched ${sel}`);
          await dom.act(async () => {
            el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
          });
          await settle();
        },
      };
      return await body(api);
    } finally {
      Object.defineProperty(globalThis, 'setTimeout', savedSet);
      Object.defineProperty(globalThis, 'clearTimeout', savedClear);
      clockRef = { now: 0 };
    }
  });
}

const MIN = 60_000;
const STALLED = '[data-testid="job-stalled"]';
const UNREACHABLE = '[data-testid="job-unreachable"]';
const PLAYER = '[data-testid="player"]';
const PROGRESS = '[data-testid="job-progress"]';

// ═══ the harness, pinned first ═══════════════════════════════════════════════

test('every import JobView has is stubbed or real, so a new one cannot silently crash this file', () => {
  assert.deepEqual(UNRESOLVED, [], `unstubbed: ${UNRESOLVED.join(', ')}`);
});

test('the harness really runs the effect: a healthy job reaches the page from a fetch, not a seed', async () => {
  // If this fails, every assertion below is about a component that never
  // polled, and the whole file is vacuous.
  await drive(
    () => ({ body: job('separating') }),
    async (p) => {
      assert.equal(p.fetchCount, 1, 'the effect did not call fetch on mount');
      assert.ok(p.has(PROGRESS), 'a healthy job does not render progress');
      assert.match(p.text(), /Processing…/);
      await p.advance(POLL_MS);
      assert.equal(p.fetchCount, 2, 'the effect did not re-arm its timer at POLL_MS');
      await p.advance(5 * POLL_MS);
      assert.equal(p.fetchCount, 7, 'the healthy poll cadence is not POLL_MS');
    },
  );
});

// ═══ unreachable: the panel appears, on ANY failure, after exactly 5 ═════════

test('five failed polls put the unreachable panel on the page', async () => {
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      assert.equal(p.has(UNREACHABLE), false, 'one failure is not an outage');
      assert.match(p.text(), /Loading…/, 'a failed first poll must not be rendered as a job');
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      assert.equal(p.fetchCount, 5);
      assert.ok(p.has(UNREACHABLE), 'five consecutive failures did not reach the unreachable panel');
      assert.doesNotMatch(p.text(), /Processing…/, 'a failed poll is still being rendered as progress');
    },
  );
});

test('FOUR failed polls do NOT: the budget is 5, and nothing here reads the constant', async () => {
  // Deliberately written with literals. Every other sequence test loops to
  // MAX_CONSECUTIVE_FAILURES, so raising it to 50 keeps them green while the
  // user waits 200 s instead of 16 s for the page to admit anything is wrong.
  assert.equal(MAX_CONSECUTIVE_FAILURES, 5, 'the budget changed: this scenario was written for 5');
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      for (let i = 0; i < 3; i++) await p.advance(BACKOFF_POLL_MS);
      assert.equal(p.fetchCount, 4);
      assert.equal(p.has(UNREACHABLE), false, 'the page gave up after 4 failures, not 5');
      await p.advance(BACKOFF_POLL_MS);
      assert.equal(p.fetchCount, 5);
      assert.ok(p.has(UNREACHABLE), 'the page did not give up after 5 failures');
    },
  );
});

test('the failure count ACCUMULATES across polls: it is not reset each time round', async () => {
  // The mutation this exists for sets `failures = 0` at the top of every poll.
  // The panel then never appears, however long the outage lasts, and every test
  // that only drives five polls and asserts "no panel yet" still passes.
  await drive(
    () => ({ status: 503 }),
    async (p) => {
      for (let i = 0; i < 20; i++) await p.advance(BACKOFF_POLL_MS + SLOW_POLL_MS);
      assert.ok(p.fetchCount >= 20, `precondition: at least 20 polls happened, got ${p.fetchCount}`);
      assert.ok(
        p.has(UNREACHABLE),
        `after ${p.fetchCount} consecutive failed polls the page still shows no outage: the failure count is being reset`,
      );
    },
  );
});

test('a mid-outage success resets the budget, so a flapping backend never trips the panel', async () => {
  let n = 0;
  await drive(
    () => (++n % 4 === 0 ? { body: job('separating') } : { status: 500 }),
    async (p) => {
      for (let i = 0; i < 30; i++) await p.advance(BACKOFF_POLL_MS);
      assert.ok(p.fetchCount > 20, 'precondition: the scenario actually polled');
      assert.equal(p.has(UNREACHABLE), false, 'a success every 4th poll must keep resetting the count');
    },
  );
});

test('unreachable is not a synonym for 500: a network rejection, a 502 and a bad body reach it too', async () => {
  // A mutation that fires `unreachable` only on `status === 500` survives every
  // other sequence test in this file, because they all use a 500.
  for (const [what, make] of [
    ['fetch rejected (offline / DNS / CORS)', () => new TypeError('Failed to fetch')],
    ['502 bad gateway', () => ({ status: 502 })],
    ['429 rate limited', () => ({ status: 429 })],
    ['200 whose body is not a job', () => ({ status: 200, body: { error_code: 'INTERNAL_ERROR' } })],
    ['200 that is not JSON at all', () => ({ status: 200, badJson: true })],
  ]) {
    await drive(make, async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      assert.equal(p.fetchCount, 5, `${what}: the scenario did not reach 5 polls`);
      assert.ok(p.has(UNREACHABLE), `${what} never reached the unreachable panel`);
    });
  }
});

test('the panel says WHOSE fault it is: a 500 is ours, a rejected fetch may be the connection', async () => {
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      const t = p.text();
      assert.match(t, /\(500\)/, 'the status our server actually gave is not on the page');
      assert.doesNotMatch(t, /Check your connection/, "a 500 is being blamed on the user's connection");
    },
  );
  await drive(
    () => new TypeError('Failed to fetch'),
    async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      assert.match(p.text(), /Check your connection/, 'a real network failure may say so');
    },
  );
});

// ═══ R3 — a short outage self-heals, WITHOUT a click ═════════════════════════

test('REGRESSION 3: five 500s then recovery heals the page on its own', async () => {
  // Base self-healed because it never stopped polling. The first version of this
  // feature returned from the effect on `unreachable`, so the panel stayed up
  // until the user clicked "Try again" — review measured 31 minutes of it.
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      assert.ok(p.has(UNREACHABLE), 'precondition: the outage panel is up');
      const atPanel = p.fetchCount;

      // the backend comes back. NOBODY CLICKS ANYTHING.
      p.serve(() => ({ body: job('done') }));
      await p.advance(SLOW_POLL_MS);

      assert.ok(p.fetchCount > atPanel, `the page stopped polling: fetch count frozen at ${atPanel}`);
      assert.equal(p.has(UNREACHABLE), false, 'the stale "we can\'t get an update" claim was never retracted');
      assert.ok(p.has(PLAYER), 'the finished track never appeared');
    },
  );
});

test('the slow poll keeps running for as long as the outage lasts, and stays slow', async () => {
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      const atPanel = p.fetchCount;
      await p.advance(10 * SLOW_POLL_MS);
      const after = p.fetchCount - atPanel;
      assert.ok(after >= 9, `expected ~10 slow polls in 10 intervals, got ${after}`);
      assert.ok(after <= 12, `the "slow" poll is not slow: ${after} polls in 10 intervals`);
    },
  );
});

test('"Try again" still works, so the manual path back is not the only path back', async () => {
  await drive(
    () => ({ status: 500 }),
    async (p) => {
      for (let i = 0; i < 4; i++) await p.advance(BACKOFF_POLL_MS);
      assert.ok(p.has(UNREACHABLE));
      p.serve(() => ({ body: job('done') }));
      await p.click('[data-testid="job-unreachable"] button');
      assert.equal(p.has(UNREACHABLE), false);
      assert.ok(p.has(PLAYER));
    },
  );
});

// ═══ stalled: the panel, the threshold, and R2 ═══════════════════════════════

test('a job queued past the threshold gets the stall panel, and it names the queue', async () => {
  await drive(
    () => ({ body: job('queued') }),
    async (p) => {
      assert.equal(p.has(STALLED), false, 'a fresh queued job is not stalled');
      await p.advance(QUEUED_STALL_MS + MIN);
      assert.ok(p.has(STALLED), 'a job queued past the threshold never reached the stall panel');
      assert.match(p.text(), /waiting in line for more than 90 minutes/);
      assert.equal(p.has(PROGRESS), false, 'a progress bar over a stalled job is the lie this replaced');
    },
  );
});

test('THE BETA BLOCKER: a job queued 21 minutes behind one other job is left alone', async () => {
  // The threshold was derived from `replicate_client.py`'s CODE DEFAULT of 55 s
  // and landed at 20 min. The deployed REPLICATE_DEADLINE is 300, so one job
  // ahead can hold the single worker for 74 min; on a ten-tester beta, queueing
  // behind one job is the NORMAL case and this panel fired on healthy jobs.
  await drive(
    () => ({ body: job('queued') }),
    async (p) => {
      await p.advance(21 * MIN);
      assert.equal(p.has(STALLED), false, 'a healthy queued job is being called stalled');
      assert.match(p.text(), /Processing…/, 'a healthy queued job should still show progress');
      await p.advance(60 * MIN);
      assert.equal(p.has(STALLED), false, 'still healthy at 81 minutes: one job ahead can take 74');
    },
  );
});

test('REGRESSION 2: a job that stalls and THEN finishes still renders, unaided', async () => {
  // The scenario review measured on the PR: the page showed "nothing has picked
  // it up" and then stopped polling — fetch count frozen — so the track that
  // finished four minutes later never appeared at all.
  await drive(
    () => ({ body: job('queued') }),
    async (p) => {
      await p.advance(QUEUED_STALL_MS + MIN);
      assert.ok(p.has(STALLED), 'precondition: the stall panel is up');
      const atPanel = p.fetchCount;

      // the worker gets to it and finishes. NOBODY CLICKS ANYTHING.
      p.serve(() => ({ body: job('done') }));
      await p.advance(4 * MIN);

      assert.ok(p.fetchCount > atPanel, `the page stopped polling: fetch count frozen at ${atPanel}`);
      assert.ok(p.has(PLAYER), 'the finished track never appeared');
      assert.equal(p.has(STALLED), false, 'the page still claims nothing has picked it up');
    },
  );
});

test('a stalled job that resumes WITHOUT finishing also retracts the claim', async () => {
  await drive(
    () => ({ body: job('queued') }),
    async (p) => {
      await p.advance(QUEUED_STALL_MS + MIN);
      assert.ok(p.has(STALLED));
      // the worker claims it: fresh updated_at, active status
      p.serve((_n, now) => ({ body: job('separating', { updated_at: new Date(SERVER_NOW + now).toISOString() }) }));
      await p.advance(SLOW_POLL_MS);
      assert.equal(p.has(STALLED), false, 'the stall claim outlived the thing it described');
      assert.ok(p.has(PROGRESS));
    },
  );
});

test('the stalled poll keeps running, so the panel is a notice and not a stop', async () => {
  await drive(
    () => ({ body: job('queued') }),
    async (p) => {
      await p.advance(QUEUED_STALL_MS + MIN);
      const atPanel = p.fetchCount;
      await p.advance(5 * SLOW_POLL_MS);
      assert.ok(p.fetchCount >= atPanel + 4, `the stalled page stopped asking: ${atPanel} -> ${p.fetchCount}`);
    },
  );
});

test('an ACTIVE job gone quiet stalls on the reaper window, with its own sentence', async () => {
  await drive(
    // updated_at never moves while the status stays active: a wedged worker.
    () => ({ body: job('separating') }),
    async (p) => {
      await p.advance(12 * MIN);
      assert.ok(p.has(STALLED), 'an active job quiet for 12 min is past the 11 min reaper window');
      assert.match(p.text(), /stopped making progress more than 11 minutes ago/);
      assert.doesNotMatch(p.text(), /waiting in line/);
    },
  );
});

// ═══ the branches that must still stop ═══════════════════════════════════════

test('a done job stops the poll for good: nothing keeps asking about a finished track', async () => {
  await drive(
    () => ({ body: job('done') }),
    async (p) => {
      assert.ok(p.has(PLAYER));
      const at = p.fetchCount;
      await p.advance(20 * SLOW_POLL_MS);
      assert.equal(p.fetchCount, at, 'a finished job is still being polled');
      assert.equal(p.clock.pending, 0, 'a timer is still armed over a finished job');
    },
  );
});

test('a 404 stops the poll and says the job is gone', async () => {
  await drive(
    () => ({ status: 404, body: { error_code: 'NOT_FOUND' } }),
    async (p) => {
      assert.match(p.text(), /find that job/);
      assert.equal(p.has(UNREACHABLE), false, 'a 404 is "gone", not "unreachable"');
      const at = p.fetchCount;
      await p.advance(20 * SLOW_POLL_MS);
      assert.equal(p.fetchCount, at, 'a 404 job is still being polled');
    },
  );
});

test('a failed job renders its own reason and stops', async () => {
  await drive(
    () => ({ body: job('failed', { error_message_user: 'That file could not be read.' }) }),
    async (p) => {
      assert.match(p.text(), /That file could not be read\./);
      const at = p.fetchCount;
      await p.advance(20 * SLOW_POLL_MS);
      assert.equal(p.fetchCount, at, 'a failed job is still being polled');
    },
  );
});

test('unmounting cancels the timer: no poll survives the page', async () => {
  await drive(
    () => ({ body: job('separating') }),
    async (p) => {
      await p.advance(POLL_MS);
      assert.ok(p.clock.pending > 0, 'precondition: a timer is armed');
      await p.dom.unmountAll();
      assert.equal(p.clock.pending, 0, 'the effect cleanup left a timer armed');
    },
  );
});
