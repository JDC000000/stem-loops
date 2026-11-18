// Transpile a slice of src/ into node-loadable ESM, following its imports.
//
// WHY. Several suites server-render the player (Player.tsx, JobView.tsx) under
// node:test, which cannot load `.tsx` or resolve the `@/` alias. They used to
// hand-wire every module (transpile X, then `.replace()` each specifier of Y to
// point at X), so every new import in the player broke five harnesses at once
// with ERR_MODULE_NOT_FOUND. This walks the real import graph instead: each
// reachable source file is transpiled once, its specifiers rewritten to the
// transpiled siblings, CSS modules replaced by a class-name proxy, and any file
// named in `overrides` replaced by the stub source given (ChordOverlay pulls
// onnxruntime-web; report-failure pulls Sentry).
//
// It changes nothing about WHAT is tested: the real modules are the real
// modules, and a stub is a stub only where the caller says so, by path.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(WEB, 'src');

const CSS_PROXY = 'export default new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });';

function toJs(src, jsx) {
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;
}

function resolveSource(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // a package: leave it to node
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`module-graph: cannot resolve ${spec} from ${relative(WEB, fromFile)}`);
}

/**
 * @param {object} opts
 * @param {string} opts.name   cache directory prefix
 * @param {string[]} opts.entries  source paths relative to src/ (e.g. 'components/play/Player.tsx')
 * @param {Record<string, string>} [opts.overrides]  src-relative path -> stub ESM source
 * @param {Record<string, string>} [opts.packages]  bare package specifier (e.g. 'next/link') -> stub ESM source
 * @returns {{ dir: string, url: (rel: string) => string, file: (rel: string) => string }}
 */
export function buildModuleGraph({ name, entries, overrides = {}, packages = {} }) {
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, `${name}-`));
  const outName = (abs) => relative(SRC, abs).replace(/[\\/]/g, '__').replace(/\.(tsx?|css)$/, '') + (abs.endsWith('.css') ? '.css.mjs' : '.mjs');
  const done = new Set();

  const visit = (abs) => {
    if (done.has(abs)) return;
    done.add(abs);
    const rel = relative(SRC, abs);
    const out = join(dir, outName(abs));
    if (abs.endsWith('.css')) {
      writeFileSync(out, CSS_PROXY);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, rel)) {
      writeFileSync(out, overrides[rel]);
      return;
    }
    let js = toJs(readFileSync(abs, 'utf8'), abs.endsWith('.tsx'));
    js = js.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g, (whole, lead, q, spec) => {
      if (Object.prototype.hasOwnProperty.call(packages, spec)) {
        const stub = join(dir, `pkg__${spec.replace(/[^\w]/g, '_')}.mjs`);
        writeFileSync(stub, packages[spec]);
        return `${lead}${q}./${relative(dir, stub)}${q}`;
      }
      const target = resolveSource(spec, abs);
      if (!target) return whole;
      visit(target);
      return `${lead}${q}./${outName(target)}${q}`;
    });
    writeFileSync(out, js);
  };
  for (const e of entries) visit(join(SRC, e));

  return {
    dir,
    file: (rel) => join(dir, outName(join(SRC, rel))),
    url: (rel) => pathToFileURL(join(dir, outName(join(SRC, rel)))).href,
  };
}
