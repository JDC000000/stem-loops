// Server-render LoginForm to static HTML (no jsdom in this repo).
// Transpiles the .tsx with the TypeScript compiler into a temp dir under
// node_modules/.cache (so bare `react` imports resolve), stubbing the
// browser-only deps. `loadLoginForm()` renders with renderToStaticMarkup, so effects and
// click handlers do NOT run: it checks what the user sees on first paint. For interactions,
// `loadLoginFormComponent()` returns the same transpiled component to mount under
// test/helpers/dom.mjs (happy-dom + real React events).
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

let built;
async function build() {
  if (built) return built;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'login-form-'));
  const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };
  const lib = (name, path) => put(name, toJs(read(path)));

  const rules = lib('password-rules.mjs', 'src/lib/auth/password-rules.ts');
  const returnTo = lib('return-to.mjs', 'src/lib/auth/return-to.ts');
  const errors = lib('login-errors.mjs', 'src/lib/auth/login-errors.ts');
  const magic = lib('magic-link.mjs', 'src/lib/auth/magic-link.ts');
  const formStyles = lib('form-styles.mjs', 'src/lib/ui/form-styles.ts');
  // A4: LoginForm reads PENDING_RETURN_TO (the home form's sign-in-first marker). The REAL module,
  // with its one relative import pointed at the transpiled YouTube validator.
  const youtube = lib('youtube-url.mjs', 'src/lib/youtube-url.ts');
  const pendingLink = put('pending-link.mjs', toJs(read('src/lib/pending-link.ts')).replace(/from ['"]\.\/youtube-url\.ts['"]/g, `from '${youtube}'`));
  // Inert client: the mount effect subscribes to auth changes and must not throw; anything a
  // test has not scripted (signInWithPassword, ...) is simply absent and surfaces inline.
  const supabase = put('supabase.mjs',
    // A test may capture the auth-change callback through globalThis.__loginStub.onAuth (A4: the
    // pending-link clear on SIGNED_OUT / a non-resume SIGNED_IN).
    'export function createBrowserClient() { return { auth: { onAuthStateChange: (cb) => { globalThis.__loginStub?.onAuth?.(cb); return { data: { subscription: { unsubscribe() {} } } }; }, ' +
    // A test may script the Google call through globalThis.__loginStub.oauth (F57 busy-label
    // test); unscripted, it returns undefined and the destructure throws, as an absent method did.
    'signInWithOAuth: (...a) => globalThis.__loginStub?.oauth?.(...a), ' +
    // QA A-08: sign-in and reset are scriptable the same way (globalThis.__loginStub.password / .reset).
    'signInWithPassword: (...a) => globalThis.__loginStub?.password?.(...a), ' +
    'resetPasswordForEmail: (...a) => globalThis.__loginStub?.reset?.(...a) } }; }');
  // 2A: records trackEvent calls into globalThis.__analyticsCalls when a test has set it (never
  // creates the global itself, so withDom's leaked-global check stays meaningful).
  const analytics = put('analytics.mjs', 'export function trackEvent(...a) { globalThis.__analyticsCalls?.push(a); } export const navigationGrace = async () => {};');
  const hcaptcha = put('hcaptcha.mjs', 'export default function HCaptcha() { return null; }');
  // The REAL show/hide password field (Slice 1b), not a stub: the toggle is what is tested.
  const passwordField = put('PasswordField.mjs', toJs(read('src/components/PasswordField.tsx'), true));

  const js = toJs(read('src/components/LoginForm.tsx'), true)
    .replace(/from ['"]@hcaptcha\/react-hcaptcha['"]/g, `from '${hcaptcha}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${supabase}'`)
    .replace(/from ['"]@\/lib\/auth\/return-to['"]/g, `from '${returnTo}'`)
    .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rules}'`)
    .replace(/from ['"]@\/lib\/auth\/login-errors['"]/g, `from '${errors}'`)
    .replace(/from ['"]@\/lib\/auth\/magic-link['"]/g, `from '${magic}'`)
    .replace(/from ['"]@\/lib\/ui\/form-styles['"]/g, `from '${formStyles}'`)
    .replace(/from ['"]@\/lib\/pending-link['"]/g, `from '${pendingLink}'`)
    .replace(/from ['"]@\/components\/PasswordField['"]/g, `from '${passwordField}'`)
    .replace(/from ['"]@\/lib\/analytics['"]/g, `from '${analytics}'`);
  const file = join(dir, 'LoginForm.mjs');
  writeFileSync(file, js);

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Form = (await import(pathToFileURL(file).href)).default;
  built = { React, Form, render: (props = {}) => renderToStaticMarkup(React.createElement(Form, props)) };
  return built;
}

export async function loadLoginForm() {
  return (await build()).render;
}

/** { React, Form } for mounting under dom.mjs. */
export async function loadLoginFormComponent() {
  const { React, Form } = await build();
  return { React, Form };
}

/** The <input type="password"> tag from rendered markup, or null. */
export const passwordInput = (html) => html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? null;
