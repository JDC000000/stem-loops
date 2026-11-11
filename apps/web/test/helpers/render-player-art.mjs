// Server-render <PlayerArt /> to static HTML (no jsdom in this repo). Same shape as
// render-login-form.mjs: transpile the .tsx with the TypeScript compiler into a temp
// dir under node_modules/.cache (so bare `react` imports resolve), stubbing the one
// config-backed import demo-data.ts carries.
//
// WHY RENDER AND NOT GREP THE SOURCE.
//
// A source-text `match` gate can be satisfied by a dead string literal. Measured on
// this PR (adversarial sweep round 2, 2026-11-11): deleting the mute and solo toggles
// from PlayerArt.tsx outright, while carrying the greppable text in a dead
// `title="toggles: >M< mute, >S< solo"` attribute, left "the drawing shows what the
// copy claims" GREEN with the drawing no longer showing either control — tsc clean,
// suite unchanged at 925/905/0/20.
//
// Stripping comments does not close that hole, because a literal is not a comment.
// Rendering does: React ESCAPES attribute values, so `>M<` can only reach the output
// as a real text node between real tags, and six channels can only appear if the rail
// is really built from STEM_ORDER. That is a property no amount of source-text
// cleverness can fake, and it needs no scanner.
//
// Effects and click handlers do NOT run — PlayerArt has none. It is static markup by
// design (no client JS, no audio), which is exactly why it renders here cleanly.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

let loaded;
/**
 * `{ html, STEM_ORDER }` — <PlayerArt /> as static HTML, plus the REAL stem list the rail is
 * built from, so a gate can assert the drawing has one channel per stem and not merely six of
 * something. Rendered once per process.
 */
export async function playerArt() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'player-art-'));
  const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };

  // demo-data.ts reads two URLs out of public-config; STEM_ORDER is a plain literal and
  // does not depend on them, so the config module is stubbed rather than loaded.
  const config = put('public-config.mjs', 'export const DEMO_BEFORE_PEAKS_URL = ""; export const DEMO_DATA_BASE = "";');
  const demo = put('demo-data.mjs', toJs(read('src/components/landing/demo-data.ts'))
    .replace(/from ['"]@\/lib\/public-config['"]/g, `from '${config}'`));

  const js = toJs(read('src/components/landing/PlayerArt.tsx'), true)
    .replace(/from ['"]\.\/demo-data['"]/g, `from '${demo}'`);
  const file = join(dir, 'PlayerArt.mjs');
  writeFileSync(file, js);

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PlayerArt } = await import(pathToFileURL(file).href);
  const { STEM_ORDER } = await import(pathToFileURL(join(dir, 'demo-data.mjs')).href);
  loaded = { html: renderToStaticMarkup(React.createElement(PlayerArt)), STEM_ORDER: [...STEM_ORDER] };
  return loaded;
}
