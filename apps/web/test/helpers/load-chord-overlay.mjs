// Load the REAL <ChordOverlay /> (a .tsx, which Node's --experimental-strip-types
// loader refuses) so a test can mount it in the happy-dom harness.
//
// WHY LOAD THE COMPONENT AND NOT ITS HELPERS.
//
// The bug this exists for was invisible chord labels: a chip rendered its name
// at `color: transparent`, so it was in the DOM, satisfied every text-content
// assertion, and could not be seen. Only the component decides a chip's colour
// and whether it has a text node at all, so only the component can be asked
// whether what the user sees matches what the DOM claims.
//
// Transpile only: the `.tsx` is converted to ESM in a temp dir and its relative
// specifiers are rewritten to absolute file URLs, so every import it makes
// resolves to the SAME src/ module the app ships — nothing here is a stub.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(WEB, 'src/components');

let loaded;

/** The real ChordOverlay component, loaded once per process. */
export async function loadChordOverlay() {
  if (loaded) return loaded;
  const src = readFileSync(join(SRC_DIR, 'ChordOverlay.tsx'), 'utf8');
  const js = ts
    .transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText // point every relative import back at the real src/ module
    .replace(/(\sfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g, (_m, kw, q, spec) =>
      `${kw}${q}${pathToFileURL(resolve(SRC_DIR, spec)).href}${q}`);

  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'chord-overlay-'));
  const file = join(dir, 'ChordOverlay.mjs');
  writeFileSync(file, js);
  loaded = await import(pathToFileURL(file).href);
  return loaded;
}
