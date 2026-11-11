// Render a real component out of src/ to static markup, with chosen import
// specifiers swapped for stubs.
//
// This is a SIBLING of render-landing-page.mjs, not an edit to it. That module
// is pinned to the landing page's entry and is being generalised on another
// open branch; adding a second entry point to it here would collide. The
// transpile-and-rewrite idea is the same one, and it is the repo's established
// way of getting a .tsx module into node (test/job-page-render.test.mjs,
// test/play-mixer.test.mjs): node's type stripping does not accept .tsx, so
// TypeScript compiles the graph into node_modules/.cache and every `@/…` and
// relative specifier is repointed at its emitted twin.
//
// WHAT THE STUBS ARE FOR, and what they are NOT allowed to do. The signed-in
// chrome reaches one thing node cannot provide: a Supabase session
// (`@/lib/auth/supabase`). That, and the router that `usePathname` reads, are
// stubbed. The COMPONENTS UNDER TEST ARE NEVER STUBBED — SignedInNav and
// SignedInChrome are the real compiled modules, and every assertion in
// signed-in-nav.test.mjs reads markup those real modules produced. A stub that
// shadowed the thing being measured would be the false-green this suite exists
// to prevent, so the stub map is asserted against an allowlist below.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(WEB, 'src');

// Only these may be replaced. Anything else is a bug in the test, not the code.
//
// The third entry needs its reason stated, because on its face it looks like
// the suite stubbing out the very component it measures. It is not.
// SignedInChrome is an ASYNC function component, and react-dom/server in React
// 18 cannot render one inside a tree — it reaches the element and finds a
// Promise. `chromePortalStub` bridges exactly that, and nothing else: the
// caller runs the REAL SignedInChrome, awaits the REAL element it returns, and
// the stub hands that same element back when the layout renders it. The props
// are the real module's, the markup is the real SignedInNav's. Replacing the
// async CALL is not replacing the component.
const STUBBABLE = new Set([
  'next/navigation',
  '@/lib/auth/supabase',
  '@/components/chrome/SignedInChrome',
]);

const resolveSrc = (p) => {
  for (const c of [p, `${p}.tsx`, `${p}.ts`, join(p, 'index.tsx'), join(p, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

/**
 * Compile `entries` (paths relative to src/) and everything they import into a
 * fresh temp mirror, writing `stubs` as standalone modules first.
 * Returns the emitted file URL of each entry, in order.
 */
export function compile(entries, stubs = {}) {
  for (const k of Object.keys(stubs)) {
    if (!STUBBABLE.has(k)) throw new Error(`refusing to stub ${k}: not in the allowlist`);
  }
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const outDir = mkdtempSync(join(cache, 'render-chrome-'));

  const stubUrl = {};
  for (const [spec, src] of Object.entries(stubs)) {
    const f = join(outDir, `__stub_${spec.replace(/[^a-z0-9]/gi, '_')}.mjs`);
    writeFileSync(f, src);
    stubUrl[spec] = pathToFileURL(f).href;
  }

  const emitted = new Map();
  const emit = (abs) => {
    if (emitted.has(abs)) return emitted.get(abs);
    const out = join(outDir, relative(SRC, abs).replace(/\.tsx?$/, '.mjs'));
    emitted.set(abs, out);
    const js = ts
      .transpileModule(readFileSync(abs, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          ...(abs.endsWith('.tsx') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
        },
      })
      .outputText.replace(/(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g, (whole, kw, q, spec) => {
        if (stubUrl[spec]) return `${kw}${q}${stubUrl[spec]}${q}`;
        const target = spec.startsWith('@/')
          ? resolveSrc(join(SRC, spec.slice(2)))
          : spec.startsWith('.')
            ? resolveSrc(join(dirname(abs), spec))
            : null;
        return target ? `${kw}${q}${pathToFileURL(emit(target)).href}${q}` : whole;
      });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, js);
    return out;
  };

  return entries.map((e) => {
    const abs = resolveSrc(join(SRC, e));
    if (!abs) throw new Error(`no such module: ${e}`);
    return pathToFileURL(emit(abs)).href;
  });
}

/** `usePathname` that answers with `p`, as the real hook does inside a router. */
export const navigationStub = (p) =>
  `export const usePathname = () => ${JSON.stringify(p)};\n` +
  `export const useRouter = () => ({ push(){}, replace(){}, refresh(){} });\n` +
  `export const useSearchParams = () => new URLSearchParams();\n` +
  `export const redirect = (u) => { const e = new Error('NEXT_REDIRECT:' + u); e.digest = 'NEXT_REDIRECT'; throw e; };\n`;

/** `getUser()` answering with `user` (an object, or null for signed out). */
export const authStub = (user) =>
  `export const getUser = async () => (${JSON.stringify(user)});\n`;

/** `getUser()` that throws — the degraded path. */
export const authThrowsStub = () =>
  `export const getUser = async () => { throw new Error('supabase unreachable'); };\n`;

/**
 * A sync stand-in for SignedInChrome that renders whatever element is parked
 * at `globalThis[key]` — see the allowlist note above. The test parks the
 * output of the real SignedInChrome there, so the layout under test renders
 * the real bar.
 */
export const chromePortalStub = (key) =>
  `export default function SignedInChromePortal() { return globalThis[${JSON.stringify(key)}] ?? null; }\n`;

/** Static markup for an element, using the real react-dom/server. */
export async function toMarkup(el) {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(el);
}
