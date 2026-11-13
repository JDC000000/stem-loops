// /jobs/[id] — THE MOUNT GATES, ASSERTED ON RENDERED OUTPUT.
//
// WHY THIS FILE EXISTS. Rounds 1–3 of review on #197 found the same defect
// class SIX times: a gate that reads JobView/Player SOURCE TEXT and is
// satisfied, or blinded, by something that is not code. Round 2 answered it
// with a comment stripper (`codeOnly` / `strip`). Round 3 broke the stripper
// three ways in one sitting, all three shipping green through
// `pnpm test` + `typecheck` + `lint` + `next build`:
//
//   FG-1  Delete the `<Player … />` mount, add `void Player;` to keep lint
//         quiet, and add `<span title={'<Player jobId={job.id} … />'} />`.
//         The player is NOT MOUNTED and both source gates pass — the string
//         literal satisfies chord-playhead's /<Player\s+jobId=/ and
//         play-player's Story 1.2 `indexOf('<Player')` at once.
//   FG-2  Add a real `<ChordOverlay jobId={job.id} />` inside
//         `<section aria-label="chords//legacy">`. The `//` in the attribute
//         STRING makes the stripper's trailing-comment rule delete the rest of
//         the line, so `<ChordOverlay` never reaches the matcher and
//         `assert.doesNotMatch` REPORTS SUCCESS WITHOUT HAVING CHECKED.
//   FG-3  Drop `jobId` from the real `<Mixer>` and add
//         `<span data-prev={'<Mixer … jobId={jobId} />'} />`. (Closed in
//         test/play-player.test.mjs, which owns Player's internal mounts.)
//
// A comment stripper is the wrong instrument, in both directions at once:
//   UNDER-inclusive — a string, template or regex literal containing the
//     pattern satisfies a `match` gate (FG-1, FG-3);
//   OVER-inclusive  — a `//` inside a string deletes real code, so a
//     `doesNotMatch` gate passes blind (FG-2).
// Adding a tokenizer would close today's two exploits with one more layer of
// regex over the same wrong instrument. The structural answer is to stop
// asserting on source text: **a string literal cannot put a mounted component
// into rendered HTML.** These tests render the real `JobView` and assert on
// the markup, which makes FG-1 and FG-2 unkillable by any source-text trick.
//
// The source-text gates are KEPT, not replaced. Comment-stripping still closes
// the round-2 false greens (a commented-out mount, a trailing `//` ordering
// claim), which rendering does not speak to. This file is an additional layer.
//
// HARNESS. There is no jsdom and node's type-stripping loader does not accept
// `.tsx`, so this uses the established repo idiom (test/job-page-gate.test.mjs,
// test/play-mixer.test.mjs): transpile the real `JobView.tsx` into
// node_modules/.cache and point its import specifiers at stubs.
//
// ⚠️ WHAT THIS FILE DOES NOT COVER, stated because round 1 of #229 let it be
// mistaken for coverage: the POLLING EFFECT. The react shim below makes
// `useEffect` a no-op and seeds `useState` positionally, so `poll()` is never
// executed here and a mutation that guts the effect body — never show the
// unreachable panel, reset the failure count every poll — passes every
// assertion in this file. The effect is covered behaviourally in
// test/job-view-poll.test.mjs (real React, real effect, stubbed fetch, virtual
// clock). This file covers what each STATE renders as; that one covers how a
// state is REACHED. Both are needed.
//
// `JobView` reaches its `done` branch only from an effect, and
// `renderToStaticMarkup` never runs effects, so `job` would stay `null` and the
// component would render "Loading…" forever. The `react` shim below therefore
// SEEDS the first `useState` with a finished job. That is the only way to reach
// the mount from node at all, and it is what makes the mount assertable rather
// than grep-able. `every assertion below would pass vacuously if the seed
// stopped working`, so the first test pins the seed itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

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
const dir = mkdtempSync(join(cache, 'job-page-render-'));
const put = (name, code) => {
  writeFileSync(join(dir, name), code);
  return './' + name;
};

// ─── the react shim ─────────────────────────────────────────────────────────
// Only the three hooks JobView imports from 'react'. JSX goes through the REAL
// 'react/jsx-runtime', which is left alone — the rewrite below matches the bare
// specifier only. No re-render ever happens in a static render, so the setters
// are inert and `useState` is a seeded read.
const reactShim = put(
  'react-shim.mjs',
  `let seeds = [];
   let cursor = 0;
   export function __seed(values) { seeds = values; cursor = 0; }
   export function useState(initial) {
     const i = cursor++;
     const seeded = i < seeds.length && seeds[i] !== undefined;
     const value = seeded ? seeds[i] : (typeof initial === 'function' ? initial() : initial);
     return [value, () => {}];
   }
   export function useRef(initial) { return { current: initial }; }
   export function useEffect() {}
   export function useMemo(fn) { return fn(); }
   export function useCallback(fn) { return fn; }`,
);

// Player stub. Records what the mount actually passed and renders a real
// element, so presence in the markup proves the component was MOUNTED.
const playerMod = put(
  'Player.mjs',
  `import { createElement } from 'react';
   export default function Player(props) {
     globalThis.__playerProps = props;
     return createElement('div', {
       'data-testid': 'player',
       'data-job-id': String(props.jobId),
       'data-enabled': String(props.enabled),
       'data-loops': Array.isArray(props.loops) ? String(props.loops.length) : String(props.loops),
     });
   }`,
);

const loopResultsMod = put(
  'LoopResults.mjs',
  `import { createElement } from 'react';
   export function LoopResults(props) {
     globalThis.__loopResultsProps = props;
     return createElement('div', { 'data-testid': 'loop-results' });
   }
   export default LoopResults;`,
);

const jobProgressMod = put(
  'JobProgress.mjs',
  `import { createElement } from 'react';
   export function JobProgress() { return createElement('div', { 'data-testid': 'job-progress' }); }
   export default JobProgress;`,
);

const linkMod = put(
  'next-link.mjs',
  `import { createElement } from 'react';
   export default function Link({ href, children, ...rest }) {
     return createElement('a', { href: String(href), ...rest }, children);
   }`,
);

const retentionMod = put(
  'retention.mjs',
  `export const formatExpiresIn = () => 'in 24 hours';`,
);

// ChordOverlay is NOT imported by JobView on a healthy tree — the overlay moved
// into Player, which owns the engine position. It is stubbed anyway, and that is
// deliberate: FG-2 reintroduces the import, and without a stub the transpiled
// module fails to resolve a bare `@/…` specifier and node:test reports
// `not ok 1 - test/job-page-render.test.mjs` — a FILE-LEVEL CRASH that looks
// exactly like a kill while actually meaning "this file never ran". The gate
// must fail on an ASSERTION, naming the defect, so the overlay has to be able
// to render.
const chordOverlayMod = put(
  'ChordOverlay.mjs',
  `import { createElement } from 'react';
   export const ChordOverlay = (props) =>
     createElement('div', { 'data-testid': 'chord-overlay', 'data-job-id': String(props.jobId) });
   export default ChordOverlay;`,
);

// The REAL job-poll module (pure; no I/O at import). JobView's polling policy
// lives there, and a stub of it would test the stub.
const jobPollMod = put('job-poll.mjs', toJs(read('src/lib/job-poll.ts')));

const jobViewJs = toJs(read('src/app/jobs/[id]/JobView.tsx'))
  // bare 'react' only — 'react/jsx-runtime' must stay real
  .replace(/from ['"]react['"]/g, `from '${reactShim}'`)
  .replace(/from ['"]@\/components\/play\/Player['"]/g, `from '${playerMod}'`)
  .replace(/from ['"]@\/components\/LoopResults['"]/g, `from '${loopResultsMod}'`)
  .replace(/from ['"]@\/components\/JobProgress['"]/g, `from '${jobProgressMod}'`)
  .replace(/from ['"]next\/link['"]/g, `from '${linkMod}'`)
  .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionMod}'`)
  .replace(/from ['"]@\/lib\/job-poll['"]/g, `from '${jobPollMod}'`)
  .replace(/from ['"]@\/components\/ChordOverlay['"]/g, `from '${chordOverlayMod}'`);
writeFileSync(join(dir, 'JobView.mjs'), jobViewJs);

// Every specifier the transpiled JobView still imports must be resolvable from
// the cache directory. Anything left starting `@/`, `next/` or a bare package
// name this harness has not stubbed would crash the whole file at import time.
const UNRESOLVED = [...jobViewJs.matchAll(/from ['"]([^'"]+)['"]/g)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('.'))
  .filter((spec) => spec !== 'react/jsx-runtime');

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const shim = await import(pathToFileURL(join(dir, 'react-shim.mjs')).href);
const JobView = (await import(pathToFileURL(join(dir, 'JobView.mjs')).href)).default;

const DONE_JOB = Object.freeze({
  id: 'job-render-1',
  status: 'done',
  original_filename: 'take-5.mp3',
  youtube_url: null,
  error_message_user: null,
  expires_at: null,
  loops: Object.freeze([
    Object.freeze({ section_label: 'Intro', start_sec: 0, end_sec: 2 }),
    Object.freeze({ section_label: 'Verse', start_sec: 2, end_sec: 8 }),
  ]),
});

/**
 * Render the real JobView with `job` seeded, so the `done` branch is reached.
 * `trouble` seeds the third `useState` (the terminal-state slot).
 */
function renderJob(job = DONE_JOB, trouble = undefined) {
  globalThis.__playerProps = null;
  globalThis.__loopResultsProps = null;
  shim.__seed([job, false, trouble]);
  return renderToStaticMarkup(React.createElement(JobView, { id: job ? job.id : 'x' }));
}

const count = (html, re) => html.match(re)?.length ?? 0;

// ═══ the harness itself, pinned first ════════════════════════════════════════

test('every import JobView has is stubbed, so a new one cannot crash this file', () => {
  // A crash here reports as `not ok 1 - test/job-page-render.test.mjs`, which is
  // indistinguishable from a kill while meaning the opposite: the gates never
  // ran. FG-2 reintroduced `@/components/ChordOverlay` and did exactly that
  // before this guard existed. Now an unstubbed import NAMES itself.
  assert.deepEqual(
    UNRESOLVED,
    [],
    `JobView imports ${UNRESOLVED.join(', ')}, which this harness does not stub — ` +
      'add a stub, or these render gates silently stop running',
  );
});

test('the harness reaches the done branch: without this every gate below is vacuous', () => {
  // If the seed stops working, `job` is null and JobView renders "Loading…".
  // Every mount assertion in this file would then pass or fail for the wrong
  // reason, so the seed is asserted before anything depends on it.
  const html = renderJob();
  assert.doesNotMatch(html, /Loading…/, 'the seed did not take: JobView is still at job=null');
  assert.match(html, /data-testid="loop-results"/, 'the done branch was not reached');
  // And the null case really does render Loading…, so the assertion above is
  // discriminating rather than always-true.
  assert.match(renderJob(null), /Loading…/, 'a null job no longer renders the loading state');
});

// ═══ FG-1 — the mount exists in RENDERED output ══════════════════════════════

test('FG-1: /jobs/[id] RENDERS a mounted Player, not a string that mentions one', () => {
  // The round-3 false green: the mount deleted, `void Player;` added to keep
  // lint quiet, and `<span title={'<Player jobId={job.id} … />'} />` added. Both
  // source-text gates passed; the player was not on the page. A string literal
  // cannot produce rendered markup, so this is the assertion that cannot be
  // faked from source.
  const html = renderJob();
  assert.match(html, /data-testid="player"/, 'the Player is NOT MOUNTED on /jobs/[id]');
  assert.equal(count(html, /data-testid="player"/g), 1, 'the Player is mounted more than once');
  // Mounted is not enough: it must receive the job's own id, which is what
  // keys per-job state downstream.
  assert.equal(
    html.match(/data-testid="player"[^>]*data-job-id="([^"]*)"/)?.[1],
    DONE_JOB.id,
    'the Player mount does not carry this job id',
  );
  // Observed through the recorded props as well as the markup, so a change to
  // the stub's own rendering cannot quietly empty this test.
  assert.equal(globalThis.__playerProps?.jobId, DONE_JOB.id);
  assert.equal(globalThis.__playerProps?.enabled, true, 'the mount lost `enabled`');
  assert.equal(globalThis.__playerProps?.loops?.length, 2, 'the mount lost `loops`');
});

// ═══ Story 1.2 — ordering, on rendered output rather than source text ════════

test('Story 1.2: the Player precedes LoopResults in the RENDERED markup', () => {
  // The source-text form of this gate lives in test/play-player.test.mjs and is
  // kept. It was defeated twice: once by JobView's header comment naming
  // `<Player>` in prose, and once by a trailing `// <Player …` on `POLL_MS`.
  // Render order cannot be influenced by either.
  const html = renderJob();
  const player = html.indexOf('data-testid="player"');
  const loops = html.indexOf('data-testid="loop-results"');
  assert.ok(player !== -1, 'no Player in the rendered output');
  assert.ok(loops !== -1, 'no LoopResults in the rendered output');
  assert.ok(player < loops, 'LoopResults renders above the Player — Story 1.2 is inverted');
});

// ═══ FG-2 — no second, position-less chord overlay ══════════════════════════

test('FG-2: the job body renders NO chord overlay of its own', () => {
  // The original #197 bug was `/jobs/[id]` mounting `<ChordOverlay jobId>` with
  // no `positionSec`, so the playhead was inert; the fix moved the overlay
  // INTO Player, which owns the engine position. The source-text guard for
  // this is a `doesNotMatch`, and round 3 blinded it: `//` inside
  // `aria-label="chords//legacy"` made the stripper delete the rest of the
  // line, so the matcher never saw the overlay and the assertion reported
  // success WITHOUT CHECKING. Here Player is stubbed, so any chord overlay in
  // this markup is a second one that JobView mounted itself — and an element
  // that renders cannot be hidden by a comment rule.
  const html = renderJob();
  assert.equal(
    count(html, /data-testid="chord-overlay"/g),
    0,
    'the job body mounts its own ChordOverlay again; only Player has a position to give it',
  );
  // Belt: the same thing stated as the element rather than the testid, in case
  // a future overlay renders without one.
  assert.doesNotMatch(html, /aria-label="[^"]*[Cc]hords/, 'a chords section is back in the job body');
});

// ═══ the other branches still render ════════════════════════════════════════

test('a failed job renders its own box and mounts no player', () => {
  const html = renderJob({ ...DONE_JOB, status: 'failed', error_message_user: 'nope' });
  assert.match(html, /Something went wrong/);
  assert.doesNotMatch(html, /data-testid="player"/, 'a failed job must not mount a player');
});

test('a processing job renders progress and mounts no player', () => {
  const html = renderJob({ ...DONE_JOB, status: 'running' });
  assert.match(html, /data-testid="job-progress"/);
  assert.doesNotMatch(html, /data-testid="player"/, 'an unfinished job must not mount a player');
});

// ═══ the page has a terminal state: it no longer says "Processing…" forever ═══

const QUEUED_JOB = Object.freeze({
  id: 'job-render-2',
  status: 'queued',
  original_filename: 'slow.mp3',
  events: [],
  loops: [],
  updated_at: '2026-11-12T10:00:00Z',
});

test('stalled QUEUED job: says so, offers Check again and a way out, and shows no progress bar', () => {
  const html = renderJob(QUEUED_JOB, { kind: 'stalled', stall: 'queued' });
  assert.match(html, /data-testid="job-stalled"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /waiting in line for more than 90 minutes/);
  assert.match(html, />Check again</);
  assert.match(html, /href="\/"[^>]*>Start a new song/);
  assert.doesNotMatch(html, /data-testid="job-progress"/, 'a progress bar over a stalled job is the lie');
  assert.doesNotMatch(html, /Processing…/);
});

test('stalled ACTIVE job names the reaper-derived window, not the queue one', () => {
  const html = renderJob({ ...QUEUED_JOB, status: 'separating' }, { kind: 'stalled', stall: 'active' });
  assert.match(html, /stopped making progress more than 11 minutes ago/);
  assert.doesNotMatch(html, /waiting in line/);
});

test('unreachable: says the page cannot get an update, offers Try again, no progress, no "Processing…"', () => {
  const html = renderJob(QUEUED_JOB, { kind: 'unreachable', status: null });
  assert.match(html, /data-testid="job-unreachable"/);
  assert.match(html, /role="alert"/);
  assert.match(html, />Try again</);
  assert.doesNotMatch(html, /data-testid="job-progress"/);
  assert.doesNotMatch(html, /Processing…/);
  // and it must not claim the TRACK failed: we do not know that
  assert.doesNotMatch(html, /Something went wrong|could not be processed/i);
});

test('unreachable copy splits by status: a 500 is OUR fault, not the user\'s connection', () => {
  // "Check your connection" for a 500 is a lie about the user's own network: our
  // server answered, it just answered badly. The two sentences must differ, and
  // the server one must not send the user to their router.
  const offline = renderJob(QUEUED_JOB, { kind: 'unreachable', status: null });
  const server = renderJob(QUEUED_JOB, { kind: 'unreachable', status: 500 });
  assert.match(offline, /Check your connection/, 'a real network failure may say so');
  assert.doesNotMatch(server, /Check your connection/, 'a 500 must not blame the user\'s connection');
  assert.match(server, /not your connection/);
  assert.match(server, /\(500\)/, 'the status the server actually gave is not shown');
  assert.match(renderJob(QUEUED_JOB, { kind: 'unreachable', status: 502 }), /\(502\)/);
  // both are still the same panel, with the same way out
  for (const html of [offline, server]) {
    assert.match(html, /data-testid="job-unreachable"/);
    assert.match(html, />Try again</);
  }
});

test('unreachable with no job at all (first poll never succeeded) is still the terminal panel, not "Loading…"', () => {
  const html = renderJob(null, { kind: 'unreachable', status: null });
  assert.match(html, /data-testid="job-unreachable"/);
  assert.doesNotMatch(html, /Loading…/);
});

test('a healthy in-flight job still renders progress (the new branches do not swallow it)', () => {
  const html = renderJob({ ...QUEUED_JOB, status: 'separating' });
  assert.match(html, /Processing…/);
  assert.match(html, /data-testid="job-progress"/);
  assert.doesNotMatch(html, /job-stalled|job-unreachable/);
});

test('a done job is never replaced by a terminal-trouble panel', () => {
  const html = renderJob(DONE_JOB, { kind: 'unreachable', status: null });
  assert.match(html, /data-testid="player"/);
  assert.doesNotMatch(html, /job-unreachable/);
});

test('JobView no longer stores a response body it did not check: no bare `setJob(data)` after `res.json()`', () => {
  const src = read('src/app/jobs/[id]/JobView.tsx');
  assert.doesNotMatch(src, /\(await res\.json\(\)\) as Job/);
  assert.match(src, /readPoll\(/);
});
