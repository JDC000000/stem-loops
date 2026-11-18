// Player — THE LOAD EFFECT, MOUNTED AND DRIVEN.
//
// WHY THIS FILE EXISTS. `test/play-player.test.mjs` drives `PlayerView` with a
// hand-built `phase`, and covers the effect with three source regexes:
//
//     assert.match(src, /zeroSourceReason\(loaded\)/);
//     assert.match(src, /reportStemFetchFailure\(reason, loaded\.stemFailures\)/);
//
// Review showed what that buys: a mutation that re-collapses EVERY zero-stem
// outcome back into the calm "no stems" note —
//
//     if (notice === null || loaded.sources.length === 0) { … no-stems … }
//
// keeps both regexes present, typechecks, and passes the whole suite. The
// product-level finding of the PR (a total encode failure must not be described
// as a job that predates play-along) is undone and nothing notices. A regex
// asserts that a call is WRITTEN; only a mount asserts that its answer is USED.
//
// So here the real effect runs: the real `load-stems.ts` over a stubbed `fetch`,
// the real engine (never `load`ed — every scenario below produces zero playable
// sources, which is the branch under test), and assertions on the banner the
// user would actually read.
//
// `report-failure` IS stubbed, deliberately: the real module holds a
// module-scoped `reported` flag so only the first call in a process does
// anything, which would make every later report assertion vacuous. The flag
// itself is covered in test/play-report-failure.test.mjs.
//
// WHAT THIS CANNOT COVER, per test/helpers/dom.mjs: layout, real CORS, and real
// decoding. A stem GET rejecting with a TypeError is what a browser does on a
// CORS miss, but it is a stub of that, not the thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildModuleGraph } from './helpers/module-graph.mjs';

import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'play-player-effect-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

// ─── the module graph ────────────────────────────────────────────────────────

// The real module graph from Player.tsx (test/helpers/module-graph.mjs), with
// two stubs: ChordOverlay (pulls onnxruntime-web; reports its position) and
// report-failure (records what would go to Sentry). The loader, engine,
// device-support and background-audio are the REAL modules — stubbing the
// loader would test the stub, and it is the thing whose answers the effect is
// accused of discarding. Under happy-dom no pointer media query matches and
// deviceMemory is absent, so device-support picks the desktop path.
const graph = buildModuleGraph({
  name: 'play-player-effect',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement } from 'react';
   export const ChordOverlay = (props) =>
     createElement('div', { 'data-testid': 'chord-overlay', 'data-view': String(props.view), 'data-position': String(props.positionSec) });
   export default ChordOverlay;`,
    'lib/play/report-failure.ts': `export function reportStemFetchFailure(reason, summary) {
     (globalThis.__stemFetchReports ??= []).push({ reason, summary });
   }`,
  },
});
const playerJs = readFileSync(graph.file('components/play/Player.tsx'), 'utf8');
const UNRESOLVED = [...playerJs.matchAll(/from ['"]([^'"]+)['"]/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('.'))
  .filter((spec) => spec !== 'react' && spec !== 'react/jsx-runtime');

const React = (await import('react')).default;
const Player = await import(graph.url('components/play/Player.tsx'));
const { PLAYABLE_STEMS } = await import(graph.url('lib/play/types.ts'));
const { ROUTE_TRANSPORT_LATENCY_SEC } = await import(graph.url('lib/play/background-audio.ts'));

const {
  NO_STEMS_MESSAGE,
  ENCODE_FAILED_MESSAGE,
  FETCH_NETWORK_MESSAGE,
  FETCH_HTTP_MESSAGE,
  FETCH_BODY_MESSAGE,
  MANIFEST_UNREACHABLE_MESSAGE,
  MANIFEST_SERVER_ERROR_MESSAGE,
  GENERIC_LOAD_MESSAGE,
  LATENCY_RESAMPLE_MS,
  stemLoadMessage,
} = Player;

// ─── the stubbed world, installed ONCE before any withDom() ──────────────────
// Installed up front so the harness's post-install global snapshot contains
// them and teardown sees no drift. `hasWebAudio` only checks that a constructor
// EXISTS, and no scenario here reaches `engine.load`, so a bare class is enough.

// A minimal WORKING context, used only when a test sets `__audioMode = 'fake'`
// (the Story 8 phone-route tests, which need the engine to reach `ready` and
// play). Every call that matters to them is appended to `__audioLog`.
function workingContext(opts) {
  const log = globalThis.__audioLog;
  const param = () => ({
    value: 1,
    setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelAndHoldAtTime() {},
  });
  const node = (kind) => ({ kind, connect(n) { return n; }, disconnect() {} });
  // `__fakeStart`: 'running' (default) or 'suspended' / 'suspended-silent' —
  // a FRESH page, where the first tap finds the context suspended and Chromium
  // reports outputLatency 0 until it runs. 'silent' = no statechange event.
  const fresh = globalThis.__fakeStart !== 'running';
  const stateListeners = [];
  const ctx = {
    sampleRate: opts?.sampleRate ?? 48000,
    currentTime: 1,
    state: fresh ? 'suspended' : 'running',
    outputLatency: fresh ? 0 : 0.032,
    baseLatency: 0.01,
    addEventListener(t, cb) { if (t === 'statechange' && globalThis.__fakeStart !== 'suspended-silent') stateListeners.push(cb); },
    removeEventListener(t, cb) { const i = stateListeners.indexOf(cb); if (i >= 0) stateListeners.splice(i, 1); },
    stateListeners,
    destination: node('destination'),
    sources: [],
    createGain() { return { ...node('gain'), gain: param() }; },
    createMediaStreamDestination() { log.push('ctx.createMediaStreamDestination'); return { ...node('stream-dest'), stream: { id: 's' } }; },
    createBufferSource() {
      const src = {
        ...node('source'), buffer: null, loop: false, loopStart: 0, loopEnd: 0, onended: null,
        start() { log.push('source.start'); },
        stop() {},
      };
      ctx.sources.push(src);
      return src;
    },
    createBuffer(c, length, sampleRate) { return fakeBuf(length, sampleRate); },
    async decodeAudioData() { return fakeBuf(120 * ctx.sampleRate, ctx.sampleRate); },
    resume() {
      log.push('ctx.resume');
      // Like a browser: the context starts running AFTER the tap, and only then
      // reports its real output latency.
      return Promise.resolve().then(() => {
        if (ctx.state === 'running') return;
        ctx.state = 'running';
        ctx.outputLatency = 0.032;
        for (const cb of stateListeners.slice()) cb();
      });
    },
    close() { return Promise.resolve(); },
  };
  globalThis.__audioContexts.push(ctx);
  return ctx;
}
function fakeBuf(length, sampleRate) {
  return { numberOfChannels: 1, length, sampleRate, duration: length / sampleRate, getChannelData: () => new Float32Array(0) };
}
class FakeAudioContext {
  constructor(opts) {
    // Recorded, then refused by default: the rate the engine ASKED for is the
    // observable (Story 8: phones ask for the light rate).
    globalThis.__audioContextRates.push(opts?.sampleRate);
    if (globalThis.__audioMode === 'fake') return workingContext(opts);
    throw new Error('no scenario in this file may construct an AudioContext');
  }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.__audioContextRates = [];
globalThis.__audioMode = 'throw';
globalThis.__fakeStart = 'running';
globalThis.__audioLog = [];
globalThis.__audioContexts = [];
// Declared here, not inside a test: the harness fails a body that ADDS a
// global, so the array has to exist before the first withDom() snapshot.
globalThis.__stemFetchReports = [];

const JOB = 'job-effect-1';
const MANIFEST = `/api/jobs/${JOB}/stems`;
const STEM_ORIGIN = 'https://stems.example.test';

let serve = () => ({ status: 500 });
let requests = [];

globalThis.fetch = async (url) => {
  const href = String(url);
  requests.push(href);
  const a = serve(href, requests.length);
  if (a instanceof Error) throw a;
  const status = a.status ?? 200;
  const bytes = a.bytes ?? null;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'content-length' && bytes) return String(bytes.byteLength);
        if (key === 'retry-after' && a.retryAfter !== undefined) return String(a.retryAfter);
        return null;
      },
    },
    // No `body`, so readBoundedBody takes its documented test-double path.
    body: null,
    arrayBuffer: async () => (bytes ? bytes.buffer : new ArrayBuffer(0)),
    json: async () => {
      if (a.badJson) throw new SyntaxError('Unexpected token');
      return a.body ?? { error_code: 'INTERNAL_ERROR', message: 'boom' };
    },
  };
};

/** A manifest body listing every playable stem, with `state`. */
const manifest = (state, stems = PLAYABLE_STEMS) => ({
  stems: stems.map((s) => ({ stem: s, signed_url: `${STEM_ORIGIN}/${JOB}/${s}.opus?sig=REDACTED` })),
  expected: PLAYABLE_STEMS.length,
  complete: stems.length === PLAYABLE_STEMS.length,
  state,
  expires_in_sec: 900,
});

const isManifest = (href) => href.endsWith('/stems');

/**
 * Route by URL: `onManifest` answers the manifest request, `onStem` answers
 * every presigned stem GET.
 */
const router = (onManifest, onStem = () => ({ status: 404 })) => (href, n) =>
  isManifest(href) ? onManifest(href, n) : onStem(href, n);

/** Mount the real Player and hand the body the rendered page. */
async function mountPlayer(server, body, props = {}, setup = null) {
  return withDom(async (dom) => {
    serve = server;
    requests = [];
    globalThis.__stemFetchReports.length = 0;
    globalThis.__audioContextRates.length = 0;
    globalThis.__audioLog.length = 0;
    globalThis.__audioContexts.length = 0;
    const realSetTimeout = globalThis.setTimeout;
    const settle = () => dom.act(() => new Promise((r) => realSetTimeout(r, 0)));

    // Story 8.3 tests: adjust the freshly-installed window before the effect runs.
    const undo = setup ? setup() : null;
    const host = await dom.mount(React.createElement(Player.default, { jobId: JOB, enabled: true, ...props }));
    // the load is async: drain the fetch -> json -> stem GETs -> setState chain
    await settle();
    await settle();

    const api = {
      dom,
      host,
      settle,
      serve: (fn) => {
        serve = fn;
      },
      text: () => host.textContent ?? '',
      banner: () => dom.find('[data-testid="player-banner"]')?.textContent ?? null,
      phase: () => dom.find('[data-testid="player"]')?.getAttribute('data-phase') ?? null,
      retry: () => dom.find('[data-testid="player-retry"]'),
      reports: () => globalThis.__stemFetchReports,
      get requests() {
        return requests;
      },
      click: async (sel) => {
        const el = dom.find(sel);
        assert.ok(el, `no element matched ${sel}`);
        await dom.act(async () => {
          el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await settle();
        await settle();
      },
    };
    try {
      return await body(api);
    } finally {
      undo?.();
    }
  });
}

const sixBytes = () => new Uint8Array([1, 2, 3, 4, 5, 6]);
const bannerEl = (p) => p.dom.find('[data-testid="player-banner"]');

// ═══ the harness, pinned first ═══════════════════════════════════════════════

test('every import Player has is stubbed or real, so a new one cannot silently crash this file', () => {
  assert.deepEqual(UNRESOLVED, [], `unstubbed: ${UNRESOLVED.join(', ')}`);
});

test('the harness really runs the effect: the phase leaves `idle` because of a fetch', async () => {
  // `Player` only leaves `idle` from the effect. A static render cannot, which
  // is exactly why the effect went uncovered. If this fails, every assertion
  // below is about a component that never loaded anything.
  await mountPlayer(
    router(() => ({ body: manifest('unavailable', []) })),
    async (p) => {
      assert.ok(
        p.requests.some(isManifest),
        'the effect never requested the manifest: it did not run',
      );
      assert.notEqual(p.phase(), 'idle', 'the effect ran but never moved the phase off idle');
    },
  );
});

test('`enabled: false` loads nothing at all: the stems route 404s an unfinished job', async () => {
  await mountPlayer(
    router(() => ({ body: manifest('ready') })),
    async (p) => {
      assert.deepEqual(p.requests, [], 'a job that is not done must not be fetched');
      assert.equal(p.phase(), 'idle');
      assert.equal(p.banner(), null);
    },
    { enabled: false },
  );
});

// ═══ THE FINDING: the zero-stem outcomes are DIFFERENT SENTENCES ═════════════
// These two tests are the pair. Either alone is satisfied by a mutation that
// collapses everything back into the calm note; together they are not.

test('`unavailable` + no stems is the CALM note, and asserts no cause', async () => {
  await mountPlayer(
    router(() => ({ body: manifest('unavailable', []) })),
    async (p) => {
      assert.equal(p.phase(), 'no-stems');
      assert.equal(p.banner(), NO_STEMS_MESSAGE);
      assert.equal(p.retry(), null, 'nothing to retry: nothing was ever stored');
      assert.deepEqual(p.reports(), [], 'the worker already knows; the browser must not report this');
      // The sentence this PR exists to remove: it describes a legacy job and is
      // false of a fresh one, and the route cannot tell the two apart.
      assert.doesNotMatch(p.text(), /processed before/i);
    },
  );
});

test('`encode_failed` is a FAULT with its own sentence, not the calm note', async () => {
  // THE MUTATION THIS KILLS: re-collapsing every zero-stem outcome into
  // `no-stems`. The stems were separated and uploaded for download; what failed
  // was preparing them for playback, and only the user who is told that knows
  // that resubmitting is the retry.
  await mountPlayer(
    router(() => ({ body: manifest('encode_failed', []) })),
    async (p) => {
      assert.equal(p.phase(), 'load-error', 'an encode failure is being rendered as "no stems were kept"');
      assert.equal(p.banner(), ENCODE_FAILED_MESSAGE);
      assert.notEqual(p.banner(), NO_STEMS_MESSAGE);
      assert.match(p.banner(), /add the track again/, 'the user is not told how to retry');
      assert.equal(p.retry(), null, 'a reload cannot fix an encode failure, so no retry is offered');
      assert.deepEqual(p.reports(), [], 'the worker reports encode failures once per job, not per page view');
      // the banner is an alert, not a status pill
      assert.equal(bannerEl(p).getAttribute('role'), 'alert');
    },
  );
});

test('every stem GET rejecting (the CORS signature) is a NETWORK sentence, and is reported', async () => {
  // THE MUTATION THIS KILLS, twice over: collapsing this into the calm note,
  // and dropping the `reportStemFetchFailure` call from the effect. Nothing
  // server-side can see a missing R2 CORS rule; if this telemetry is dead and
  // the bucket's CORS is wrong, that is every user, silently.
  await mountPlayer(
    router(
      () => ({ body: manifest('ready') }),
      () => new TypeError('Failed to fetch'),
    ),
    async (p) => {
      assert.equal(p.phase(), 'load-error');
      assert.equal(p.banner(), FETCH_NETWORK_MESSAGE);
      assert.notEqual(p.banner(), NO_STEMS_MESSAGE);
      assert.ok(p.retry(), 'a network failure is worth retrying, so the button must be offered');

      assert.equal(p.reports().length, 1, 'the browser-only failure was not reported');
      const [r] = p.reports();
      assert.equal(r.reason, 'FETCH_NETWORK');
      assert.equal(r.summary.network, PLAYABLE_STEMS.length, 'the count of network failures did not reach the report');
      assert.equal(r.summary.listed, PLAYABLE_STEMS.length);
      assert.deepEqual(r.summary.storageOrigins, [STEM_ORIGIN], 'the owner needs the origin to fix the CORS rule');
      // and never a presigned signature
      assert.doesNotMatch(JSON.stringify(r), /REDACTED|sig=/, 'a presigned signature reached the reporter');
      assert.doesNotMatch(JSON.stringify(r), new RegExp(JOB), 'the job id reached the reporter');
    },
  );
});

test('every stem GET answering 404 is an HTTP sentence, distinct from the network one', async () => {
  await mountPlayer(
    router(
      () => ({ body: manifest('ready') }),
      () => ({ status: 404 }),
    ),
    async (p) => {
      assert.equal(p.phase(), 'load-error');
      assert.equal(p.banner(), FETCH_HTTP_MESSAGE);
      assert.notEqual(p.banner(), FETCH_NETWORK_MESSAGE, 'storage answering is not the browser failing to reach it');
      assert.notEqual(p.banner(), NO_STEMS_MESSAGE);
      assert.ok(p.retry());
      assert.equal(p.reports()[0]?.reason, 'FETCH_HTTP');
      assert.deepEqual(p.reports()[0]?.summary.httpStatuses, [404]);
    },
  );
});

test('every stem GET answering 200 with an empty body is a BODY sentence', async () => {
  await mountPlayer(
    router(
      () => ({ body: manifest('ready') }),
      () => ({ status: 200 }),
    ),
    async (p) => {
      assert.equal(p.banner(), FETCH_BODY_MESSAGE);
      assert.notEqual(p.banner(), NO_STEMS_MESSAGE);
      assert.equal(p.reports()[0]?.reason, 'FETCH_BODY');
      assert.equal(p.reports()[0]?.summary.body, PLAYABLE_STEMS.length);
    },
  );
});

test('the four zero-stem sentences are four DIFFERENT sentences', async () => {
  // Stated once, as a set, so a mutation that makes any two of them equal fails
  // here even if it slips past the scenario it belongs to.
  const seen = new Set();
  for (const [state, stem] of [
    ['unavailable', null],
    ['encode_failed', null],
    ['ready', () => new TypeError('x')],
    ['ready', () => ({ status: 500 })],
  ]) {
    await mountPlayer(
      router(() => ({ body: manifest(state, stem ? PLAYABLE_STEMS : []) }), stem ?? undefined),
      async (p) => {
        const b = p.banner();
        assert.ok(b, `${state} rendered no banner at all`);
        assert.equal(seen.has(b), false, `two zero-stem outcomes render the SAME sentence: ${b}`);
        seen.add(b);
      },
    );
  }
  assert.equal(seen.size, 4);
});

// ═══ MANIFEST_FAILED splits by status ════════════════════════════════════════

test('a manifest 500 says a SERVER error — not "check your connection", which is a lie', async () => {
  await mountPlayer(
    router(() => ({ status: 500 })),
    async (p) => {
      assert.equal(p.phase(), 'load-error');
      assert.equal(p.banner(), MANIFEST_SERVER_ERROR_MESSAGE);
      assert.doesNotMatch(p.banner(), /Check your connection/, "a 500 was blamed on the user's connection");
      assert.match(p.banner(), /on our end/);
      assert.ok(p.retry(), 'a 5xx is worth retrying');
    },
  );
});

test('a manifest 502 — the route\'s own loud R2-list fault — says the same server sentence', async () => {
  await mountPlayer(
    router(() => ({ status: 502, body: { error_code: 'STEM_LIST_FAILED' } })),
    async (p) => {
      assert.equal(p.banner(), MANIFEST_SERVER_ERROR_MESSAGE);
      assert.doesNotMatch(p.banner(), /Check your connection/);
    },
  );
});

test('a manifest request that never got a response DOES say check your connection', async () => {
  await mountPlayer(
    router(() => new TypeError('Failed to fetch')),
    async (p) => {
      assert.equal(p.banner(), MANIFEST_UNREACHABLE_MESSAGE);
      assert.match(p.banner(), /Check your connection/);
      assert.notEqual(p.banner(), MANIFEST_SERVER_ERROR_MESSAGE, 'no response and a bad response are not the same thing');
    },
  );
});

test('stemLoadMessage splits on whether a response EXISTED, not on a status range', () => {
  // The pure half of the split, pinned so the branch cannot be rewritten to
  // `status >= 500` — a 403 from a misconfigured edge is no more the user's
  // connection than a 500 is.
  assert.equal(stemLoadMessage('MANIFEST_FAILED'), MANIFEST_UNREACHABLE_MESSAGE);
  assert.equal(stemLoadMessage('MANIFEST_FAILED', undefined), MANIFEST_UNREACHABLE_MESSAGE);
  for (const status of [400, 403, 418, 500, 502, 503]) {
    assert.equal(stemLoadMessage('MANIFEST_FAILED', status), MANIFEST_SERVER_ERROR_MESSAGE, String(status));
  }
  assert.notEqual(MANIFEST_SERVER_ERROR_MESSAGE, MANIFEST_UNREACHABLE_MESSAGE);
  // the other codes are untouched by the split
  assert.equal(stemLoadMessage('MANIFEST_INVALID'), GENERIC_LOAD_MESSAGE);
  assert.equal(stemLoadMessage('MANIFEST_INVALID', 500), GENERIC_LOAD_MESSAGE);
});

test('a manifest 404 is "gone", a 429 is "too fast", and neither offers a retry button', async () => {
  await mountPlayer(
    router(() => ({ status: 404, body: { error_code: 'NOT_FOUND' } })),
    async (p) => {
      assert.match(p.banner(), /no longer available/);
      assert.equal(p.retry(), null, 'a deleted job cannot be retried');
    },
  );
  await mountPlayer(
    router(() => ({ status: 429, retryAfter: 30 })),
    async (p) => {
      assert.match(p.banner(), /sending requests too fast\. Wait a minute and reload\./);
      assert.equal(p.retry(), null, 'retrying immediately is the wrong answer to a rate limit');
    },
  );
});

test('a 2xx manifest of the wrong shape is the generic sentence, with a retry', async () => {
  await mountPlayer(
    router(() => ({ status: 200, badJson: true })),
    async (p) => {
      assert.equal(p.banner(), GENERIC_LOAD_MESSAGE);
      assert.ok(p.retry());
    },
  );
});

// ═══ the retry button actually re-runs the load ══════════════════════════════

test('"Try again" re-runs the load effect, and a second answer replaces the first', async () => {
  // `onRetry` bumps `attempt`, which is in the effect's dependency list. A
  // mutation that drops it leaves a button that does nothing.
  await mountPlayer(
    router(() => ({ status: 500 })),
    async (p) => {
      assert.equal(p.banner(), MANIFEST_SERVER_ERROR_MESSAGE);
      const before = p.requests.length;
      p.serve(router(() => ({ body: manifest('encode_failed', []) })));
      await p.click('[data-testid="player-retry"]');
      assert.ok(p.requests.length > before, 'Try again fetched nothing: the effect was not re-run');
      assert.equal(p.banner(), ENCODE_FAILED_MESSAGE, 'the second load did not reach the page');
    },
  );
});

// ═══ a partial load still plays, and says which stem is gone ═════════════════

test('one stem failing out of six is NOT a zero-stem outcome: nothing is reported and no error banner', async () => {
  // The other half of the finding: a delivery fault that still produced audio
  // must not be dressed up as a failure. (The engine is not loaded here — the
  // AudioContext would be — so this asserts the EFFECT's branch choice: it
  // reached `engine.load`, which means `sources.length > 0`.)
  await mountPlayer(
    router(
      () => ({ body: manifest('partial') }),
      (href) => (href.includes('vocals') ? { status: 404 } : { status: 200, bytes: sixBytes() }),
    ),
    async (p) => {
      assert.deepEqual(p.reports(), [], 'a load that produced audio must not report a zero-source failure');
      assert.notEqual(p.banner(), FETCH_HTTP_MESSAGE, 'five playable stems were described as a total failure');
      assert.notEqual(p.banner(), NO_STEMS_MESSAGE);
      assert.notEqual(p.phase(), 'no-stems');
    },
  );
});

// ═══ teardown ════════════════════════════════════════════════════════════════

test('unmounting mid-load aborts it: the load never lands on an unmounted component', async () => {
  await mountPlayer(
    router(() => ({ body: manifest('ready') }), () => ({ status: 200, bytes: sixBytes() })),
    async (p) => {
      await p.dom.unmountAll();
      await p.settle();
      assert.equal(p.dom.find('[data-testid="player"]'), null, 'the player is still mounted');
    },
  );
});

// ═══ Story 8 — a phone is NOT blocked; it loads, at the light rate ═══════════

const sixStems = () =>
  router(() => ({ body: manifest('ready') }), () => ({ status: 200, bytes: sixBytes() }));

test('a touch-only phone is not blocked: it fetches the manifest and all six stems, like desktop', async () => {
  await mountPlayerOnTouchOnly(async (p) => {
    assert.notEqual(p.phase(), 'device-unsupported');
    assert.equal(p.dom.find('[data-testid="player-device-unsupported"]'), null);
    assert.ok(p.requests.some(isManifest), 'the phone never asked for the manifest');
    assert.equal(p.requests.filter((h) => !isManifest(h)).length, PLAYABLE_STEMS.length, 'six stem GETs');
  }, sixStems());
});

test('the phone asks the engine for the light rate first; desktop asks for 48 kHz only', async () => {
  await mountPlayerOnTouchOnly(async () => {
    // The fake refuses every context, so the engine's one retry at 48 kHz shows too.
    assert.deepEqual(globalThis.__audioContextRates, [24000, 48000]);
  }, sixStems());
  await mountPlayer(sixStems(), async () => {
    assert.deepEqual(globalThis.__audioContextRates, [48000]);
  });
});

test('lock-screen controls: Player installs Media Session handlers that drive the transport, and removes them on unmount', async () => {
  const ms = {
    metadata: undefined,
    playbackState: 'none',
    handlers: {},
    setActionHandler(a, h) {
      this.handlers[a] = h;
    },
    setPositionState() {},
  };
  await mountPlayer(
    router(() => ({ body: manifest('unavailable', []) })),
    async (p) => {
      for (const a of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward']) {
        assert.equal(typeof ms.handlers[a], 'function', `${a} handler missing`);
      }
      // No engine is loaded in this scenario: the handlers must be safe no-ops, never throws.
      assert.doesNotThrow(() => ms.handlers.play({}));
      assert.doesNotThrow(() => ms.handlers.seekto({ seekTime: 3 }));
      await p.dom.unmountAll();
      await p.settle();
      for (const a of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward']) {
        assert.equal(ms.handlers[a], null, `${a} handler left behind after unmount`);
      }
      assert.equal(ms.playbackState, 'none');
    },
    { title: 'Song.mp3' },
    () => {
      const nav = globalThis.navigator;
      Object.defineProperty(nav, 'mediaSession', { value: ms, configurable: true });
      return () => {
        delete nav.mediaSession;
      };
    },
  );
});

// ═══ Story 8 — the phone route, driven end to end through Player ═══════════
// A working fake context + a fake <audio> element + a fake Media Session, on a
// touch-only device (or desktop, for the contrast). Written failing-first
// against review #278's three surviving mutants (M13 order, M14 listener leak,
// M15 no pause on end) and the chord-clock compensation.

const RESUME_EVENTS = ['visibilitychange', 'pointerdown', 'touchend', 'pageshow', 'focus'];

async function mountRoute({ phone = true, start = 'running' } = {}, body) {
  const ms = {
    metadata: undefined, playbackState: 'none', handlers: {},
    setActionHandler(a, h) { this.handlers[a] = h; }, setPositionState() {},
  };
  const el = {
    srcObject: null, playsInline: false, autoplay: true, paused: true, pauses: 0, listeners: {},
    setAttribute() {}, removeAttribute() {},
    addEventListener(t, cb) { (this.listeners[t] ??= []).push(cb); },
    removeEventListener(t, cb) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== cb); },
    play() { globalThis.__audioLog.push('element.play'); this.paused = false; return Promise.resolve(); },
    pause() { globalThis.__audioLog.push('element.pause'); this.pauses++; this.paused = true; for (const cb of this.listeners.pause ?? []) cb(); },
  };
  const live = new Map(); // `${target}:${type}` -> count of resume listeners currently attached
  await mountPlayer(sixStems(), async (p) => {
    await p.settle();
    await p.settle();
    await body({ ...p, ms, el, live, ctx: () => globalThis.__audioContexts.at(-1) });
  }, { title: 'Song.mp3' }, () => {
    globalThis.__audioMode = 'fake';
    globalThis.__fakeStart = start;
    const doc = globalThis.document;
    const win = globalThis.window;
    const nav = globalThis.navigator;
    const realMM = globalThis.matchMedia;
    if (phone) globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(nav, 'mediaSession', { value: ms, configurable: true });
    const realCreate = doc.createElement;
    doc.createElement = function (tag, ...rest) { return tag === 'audio' ? el : realCreate.call(this, tag, ...rest); };
    const spy = (name, t) => {
      const add = t.addEventListener, rem = t.removeEventListener;
      t.addEventListener = function (type, cb, o) {
        if (RESUME_EVENTS.includes(type)) live.set(`${name}:${type}`, (live.get(`${name}:${type}`) ?? 0) + 1);
        return add.call(this, type, cb, o);
      };
      t.removeEventListener = function (type, cb, o) {
        if (RESUME_EVENTS.includes(type)) live.set(`${name}:${type}`, (live.get(`${name}:${type}`) ?? 0) - 1);
        return rem.call(this, type, cb, o);
      };
      return () => { delete t.addEventListener; delete t.removeEventListener; if (t.addEventListener !== add) { t.addEventListener = add; t.removeEventListener = rem; } };
    };
    const unspyDoc = spy('document', doc);
    const unspyWin = spy('window', win);
    return () => {
      globalThis.__audioMode = 'throw';
      globalThis.__fakeStart = 'running';
      globalThis.matchMedia = realMM;
      delete nav.mediaSession;
      delete doc.createElement;
      if (doc.createElement !== realCreate) doc.createElement = realCreate;
      unspyDoc();
      unspyWin();
    };
  });
}

/** Tap Play exactly as a user does, and return the log as it stood when the tap's handler RETURNED. */
function tapPlay(p) {
  const play = [...p.host.querySelectorAll('button')].find((b) => /play/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  assert.ok(play, 'no Play button rendered: the engine never reached ready');
  globalThis.__audioLog.length = 0;
  play.dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return globalThis.__audioLog.slice(); // synchronous: nothing awaited yet
}

test('iOS tap rule (M13): the <audio> element is started synchronously inside the tap, BEFORE the engine starts', async () => {
  await mountRoute({ phone: true }, async (p) => {
    assert.equal(p.phase(), 'ready');
    const sync = tapPlay(p);
    const iEl = sync.indexOf('element.play');
    const iSrc = sync.indexOf('source.start');
    assert.ok(iEl >= 0, `element.play() was not called inside the tap: ${sync.join(', ')}`);
    assert.ok(iSrc >= 0, `the engine did not start inside the tap: ${sync.join(', ')}`);
    assert.ok(iEl < iSrc, `engine started before the element: ${sync.join(', ')}`);
  });
});

test('desktop tap: no <audio> element is involved at all', async () => {
  await mountRoute({ phone: false }, async (p) => {
    const sync = tapPlay(p);
    assert.ok(sync.includes('source.start'));
    assert.ok(!sync.includes('element.play'), 'desktop must not route through the element');
    assert.ok(!globalThis.__audioLog.includes('ctx.createMediaStreamDestination'));
  });
});

test('song end (M15): when the engine goes playing → ended, the <audio> element is paused', async () => {
  await mountRoute({ phone: true }, async (p) => {
    tapPlay(p);
    await p.settle();
    assert.equal(p.el.paused, false);
    const before = p.el.pauses;
    await p.dom.act(async () => { for (const src of p.ctx().sources) src.onended?.(); });
    await p.settle();
    assert.ok(p.el.pauses > before, 'the element kept playing silence after the song ended');
    assert.equal(p.el.paused, true);
    assert.equal(p.ms.playbackState, 'paused', 'lock screen still says playing');
  });
});

test('unmount (M14): every resume listener and every Media Session handler is removed', async () => {
  await mountRoute({ phone: true }, async (p) => {
    const attached = [...p.live.entries()].filter(([, n]) => n > 0).map(([k]) => k);
    assert.ok(attached.length >= RESUME_EVENTS.length, `resume hooks not attached: ${attached.join(', ')}`);
    assert.equal(typeof p.ms.handlers.play, 'function');
    await p.dom.unmountAll();
    await p.settle();
    const leaked = [...p.live.entries()].filter(([, n]) => n > 0).map(([k]) => k);
    assert.deepEqual(leaked, [], `listeners left behind after unmount: ${leaked.join(', ')}`);
    for (const a of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward']) assert.equal(p.ms.handlers[a], null, a);
    assert.equal(p.el.srcObject, null, 'the element still holds the stream');
  });
});

const chordPos = (p) => Number(p.dom.find('[data-testid="chord-overlay"]').getAttribute('data-position'));

test('chord sync: on the phone route the chord clock is held back by routeLatencySec while playing', async () => {
  await mountRoute({ phone: true }, async (p) => {
    tapPlay(p);
    await p.settle();
    await p.dom.act(async () => p.ms.handlers.seekto({ seekTime: 10 }));
    await p.settle();
    const expected = 10 - (ROUTE_TRANSPORT_LATENCY_SEC + 0.032); // fake ctx outputLatency
    assert.ok(Math.abs(chordPos(p) - expected) < 1e-9, `chord at ${chordPos(p)}, expected ${expected}`);
    // paused: no compensation — the playhead sits where the audio stopped
    await p.dom.act(async () => p.ms.handlers.pause({}));
    await p.settle();
    assert.equal(chordPos(p), 10);
  });
});

test('chord sync, fresh page (review #278 B1): first play from a SUSPENDED context uses the latency it reports once RUNNING', async () => {
  await mountRoute({ phone: true, start: 'suspended' }, async (p) => {
    assert.equal(p.ctx().state, 'suspended');
    assert.equal(p.ctx().outputLatency, 0, 'fixture: a fresh context reports 0');
    tapPlay(p);
    await p.settle();
    await p.settle();
    assert.equal(p.ctx().state, 'running');
    await p.dom.act(async () => p.ms.handlers.seekto({ seekTime: 10 }));
    await p.settle();
    const expected = 10 - (ROUTE_TRANSPORT_LATENCY_SEC + 0.032);
    assert.ok(Math.abs(chordPos(p) - expected) < 1e-9, `first play compensated ${10 - chordPos(p)} s, expected ${10 - expected}`);
    assert.equal(p.ctx().stateListeners.length, 1, 'statechange listener attached once');
    await p.dom.unmountAll();
    await p.settle();
    assert.equal(p.ctx().stateListeners.length, 0, 'statechange listener left behind after unmount');
  });
});

test('chord sync, fresh page with NO statechange event: the timed re-sample still picks up the running latency', async () => {
  await mountRoute({ phone: true, start: 'suspended-silent' }, async (p) => {
    tapPlay(p);
    await p.settle();
    await p.dom.act(async () => p.ms.handlers.seekto({ seekTime: 10 }));
    await p.settle();
    await p.dom.act(() => new Promise((r) => setTimeout(r, LATENCY_RESAMPLE_MS[0] + 100)));
    await p.settle();
    const expected = 10 - (ROUTE_TRANSPORT_LATENCY_SEC + 0.032);
    assert.ok(Math.abs(chordPos(p) - expected) < 1e-9, `after re-sample compensated ${10 - chordPos(p)} s, expected ${10 - expected}`);
  });
});

test('chord sync: desktop is NOT compensated (the chord clock is the engine clock, as before)', async () => {
  await mountRoute({ phone: false }, async (p) => {
    tapPlay(p);
    await p.settle();
    await p.dom.act(async () => p.ms.handlers.seekto({ seekTime: 10 }));
    await p.settle();
    assert.equal(chordPos(p), 10);
  });
});

async function mountPlayerOnTouchOnly(body, server = router(() => ({ status: 500 }))) {
  await mountPlayer(server, body, {}, () => {
    const real = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} });
    return () => {
      globalThis.matchMedia = real;
    };
  });
}
