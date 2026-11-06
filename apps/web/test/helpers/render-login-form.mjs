// Server-render LoginForm to static HTML (no jsdom in this repo).
// Transpiles the .tsx with the TypeScript compiler into a temp dir under
// node_modules/.cache (so bare `react` imports resolve), stubbing the
// browser-only deps. Effects and click handlers do NOT run: this checks what
// the user sees on first paint, not interactions.
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
export async function loadLoginForm() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'login-form-'));
  const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };
  const lib = (name, path) => put(name, toJs(read(path)));

  const rules = lib('password-rules.mjs', 'src/lib/auth/password-rules.ts');
  const returnTo = lib('return-to.mjs', 'src/lib/auth/return-to.ts');
  const errors = lib('login-errors.mjs', 'src/lib/auth/login-errors.ts');
  const magic = lib('magic-link.mjs', 'src/lib/auth/magic-link.ts');
  const supabase = put('supabase.mjs', 'export function createBrowserClient() { throw new Error("not in SSR"); }');
  const hcaptcha = put('hcaptcha.mjs', 'export default function HCaptcha() { return null; }');

  const js = toJs(read('src/components/LoginForm.tsx'), true)
    .replace(/from ['"]@hcaptcha\/react-hcaptcha['"]/g, `from '${hcaptcha}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabase}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${returnTo}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rules}'`)
    .replace(/from ['"]@\/lib\/auth\/login-errors['"]/g, `from '${errors}'`)
    .replace(/from ['"]@\/lib\/auth\/magic-link['"]/g, `from '${magic}'`);
  const file = join(dir, 'LoginForm.mjs');
  writeFileSync(file, js);

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Form = (await import(pathToFileURL(file).href)).default;
  loaded = (props = {}) => renderToStaticMarkup(React.createElement(Form, props));
  return loaded;
}

/** The <input type="password"> tag from rendered markup, or null. */
export const passwordInput = (html) => html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? null;
