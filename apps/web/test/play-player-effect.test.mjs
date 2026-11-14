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

const typesMod = put('play-types.mjs', toJs(read('src/lib/play/types.ts')));
const cssMod = put(
  'styles.mjs',
  'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });',
);
const sectionsMod = put(
  'sections.mjs',
  toJs(read('src/lib/play/sections.ts')).replace(/from ['"]\.\/types['"]/g, `from '${typesMod}'`),
);
const rewriteShared = (js) =>
  js
    .replace(/from ['"]@\/lib\/play\/types['"]/g, `from '${typesMod}'`)
    .replace(/from ['"]@\/lib\/play\/sections['"]/g, `from '${sectionsMod}'`)
    .replace(/from ['"][^'"]*\.module\.css['"]/g, `from '${cssMod}'`);

const mixerMod = put('Mixer.mjs', rewriteShared(toJs(read('src/components/play/Mixer.tsx'), true)));
const transportMod = put('Transport.mjs', rewriteShared(toJs(read('src/components/play/Transport.tsx'), true)));
const sectionLoopMod = put('SectionLoop.mjs', rewriteShared(toJs(read('src/components/play/SectionLoop.tsx'), true)));
const chordMod = put(
  'ChordOverlay.mjs',
  `import { createElement } from 'react';
   export const ChordOverlay = (props) =>
     createElement('div', { 'data-testid': 'chord-overlay', 'data-position': String(props.positionSec) });
   export default ChordOverlay;`,
);
// The REAL loader. Stubbing it would test the stub — it is the thing whose
// answers the effect is accused of discarding.
const loadStemsMod = put(
  'load-stems.mjs',
  toJs(read('src/lib/play/load-stems.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`),
);
const reportMod = put(
  'report-failure.mjs',
  `export function reportStemFetchFailure(reason, summary) {
     (globalThis.__stemFetchReports ??= []).push({ reason, summary });
   }`,
);
const engineMod = put(
  'engine.mjs',
  toJs(read('src/lib/play/engine.ts')).replace(/from ['"]\.\/types\.ts['"]/g, `from '${typesMod}'`),
);

const playerJs = rewriteShared(toJs(read('src/components/play/Player.tsx'), true))
  .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordMod}'`)
  .replace(/from ['"]@\/lib\/play\/engine['"]/g, `from '${engineMod}'`)
  .replace(/from ['"]@\/lib\/play\/load-stems['"]/g, `from '${loadStemsMod}'`)
  .replace(/from ['"]@\/lib\/play\/report-failure['"]/g, `from '${reportMod}'`)
  .replace(/from ['"]\.\/Mixer['"]/g, `from '${mixerMod}'`)
  .replace(/from ['"]\.\/Transport['"]/g, `from '${transportMod}'`)
  .replace(/from ['"]\.\/SectionLoop['"]/g, `from '${sectionLoopMod}'`);
writeFileSync(join(dir, 'Player.mjs'), playerJs);

const UNRESOLVED = [...playerJs.matchAll(/from ['"]([^'"]+)['"]/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('.'))
  .filter((spec) => spec !== 'react' && spec !== 'react/jsx-runtime');

const React = (await import('react')).default;
const Player = await import(pathToFileURL(join(dir, 'Player.mjs')).href);
const { PLAYABLE_STEMS } = await import(pathToFileURL(join(dir, 'play-types.mjs')).href);

const {
  NO_STEMS_MESSAGE,
  ENCODE_FAILED_MESSAGE,
  FETCH_NETWORK_MESSAGE,
  FETCH_HTTP_MESSAGE,
  FETCH_BODY_MESSAGE,
  MANIFEST_UNREACHABLE_MESSAGE,
  MANIFEST_SERVER_ERROR_MESSAGE,
  GENERIC_LOAD_MESSAGE,
  stemLoadMessage,
} = Player;

// ─── the stubbed world, installed ONCE before any withDom() ──────────────────
// Installed up front so the harness's post-install global snapshot contains
// them and teardown sees no drift. `hasWebAudio` only checks that a constructor
// EXISTS, and no scenario here reaches `engine.load`, so a bare class is enough.

class FakeAudioContext {
  constructor() {
    throw new Error('no scenario in this file may construct an AudioContext');
  }
}
globalThis.AudioContext = FakeAudioContext;
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
async function mountPlayer(server, body, props = {}) {
  return withDom(async (dom) => {
    serve = server;
    requests = [];
    globalThis.__stemFetchReports.length = 0;
    const realSetTimeout = globalThis.setTimeout;
    const settle = () => dom.act(() => new Promise((r) => realSetTimeout(r, 0)));

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
    return body(api);
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
