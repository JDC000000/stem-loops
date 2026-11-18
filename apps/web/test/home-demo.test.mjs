// Slice 2a — the home page's live play-along demo (design v1.5 P4.1 item 2, P4.2).
//
// Rendered through the same real-page helper landing-copy uses (the whole module graph
// from app/(landing)/page.tsx, transpiled by the TypeScript compiler).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { landingPage } from './helpers/render-landing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(WEB, 'src/components/landing/HomeDemo.tsx'), 'utf8');
const page = await landingPage();
const html = page.html;

test('the demo is on the home page, near the top: after the H1, before the paste box', () => {
  const h1 = html.indexOf('id="h1"');
  const demo = html.indexOf('data-testid="home-demo"');
  const tool = html.indexOf('id="tool"');
  assert.ok(h1 > -1 && demo > -1 && tool > -1, 'h1, demo and tool must all render');
  assert.ok(h1 < demo && demo < tool, `order h1=${h1} demo=${demo} tool=${tool}`);
});

test('the poster says no account is needed and names the first demo song with its BPM and key', () => {
  assert.match(page.textSpaced, /Try it now · no account needed/);
  assert.match(html, /data-testid="home-demo-title"[^>]*>Lucky Ticket</);
  assert.match(page.textSpaced, /The Royal Sundowners · 102 BPM · A major/);
  for (const s of ['Lucky Ticket', 'I’m Asking You', 'Offline']) assert.ok(page.textSpaced.includes(s), s);
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*data-testid="home-demo-song-lucky-ticket"/);
  assert.match(html, /href="\/demo\/lucky-ticket"/, 'the stand-alone demo link');
});

test('P4.2: nothing loads until Play is tapped — no player, no fetch, no audio in the server render', () => {
  assert.doesNotMatch(html, /data-testid="player"/);
  assert.doesNotMatch(html, /data-testid="home-demo-layer"/);
  // The player module is not a static import of the home page: it is fetched on the tap.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^import[^;]*DemoPlayerLayer/m, 'the player layer is statically imported');
  assert.doesNotMatch(code, /^import[^;]*(components\/play|jobs\/\[id\])/m, 'the player is statically imported');
  assert.match(code, /import\('\.\/DemoPlayerLayer'\)/);
  // The only fetch is inside the tap handler, not at module scope or in an effect.
  const openFn = /const open = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(code)?.[1] ?? '';
  assert.match(openFn, /fetch\('\/api\/demos'\)/);
  assert.equal((code.match(/fetch\(/g) ?? []).length, 1, 'a second fetch crept in');
});

test('one lime action per view (brand v2.3 A3): the demo Play is not btn-primary', () => {
  assert.match(html, /class="btn btn-secondary btn-play demo-play"/);
  const demo = html.slice(html.indexOf('data-testid="home-demo"'), html.indexOf('id="tool"'));
  assert.doesNotMatch(demo, /btn-primary/);
});

const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

test('pickDemoJob: the chosen song when the API has it; else the first playable demo; else null', async () => {
  const { pickDemoJob } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        `export ${/export function pickDemoJob[\s\S]*?\n\}/.exec(toJs(SRC))[0].replace(/^export /, '')}`,
      ).toString('base64')
  );
  const demos = [
    { id: 'a', slug: 'lucky-ticket' },
    { id: 'b', slug: 'offline' },
  ];
  assert.equal(pickDemoJob(demos, 'offline'), 'b');
  assert.equal(pickDemoJob(demos, 'im-asking-you'), 'a');
  assert.equal(pickDemoJob([{ id: 'z', slug: null }], 'lucky-ticket'), 'z');
  assert.equal(pickDemoJob([], 'lucky-ticket'), null);
});

test('the layer is portalled out of the page main and makes the rest of the page inert', () => {
  const layer = readFileSync(join(WEB, 'src/components/landing/DemoPlayerLayer.tsx'), 'utf8');
  assert.match(layer, /createPortal\(/);
  assert.match(layer, /setAttribute\('inert', ''\)/);
  assert.match(layer, /signedIn=\{false\}/, 'the layer must say "Back to home"');
  assert.match(layer, /onBack=\{onClose\}/, 'the back arrow must close the layer in place');
});
