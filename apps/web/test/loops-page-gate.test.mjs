// /loops page.tsx — the sign-in gate and the `?job` filter, run as the REAL module.
//
// Review of #277 (mutants M10, M11): removing the signed-out redirect, or the uuid check
// on `?job`, left every other suite green. This file runs the real server component
// with only its outside world replaced: the session (`getUser`), Next's `redirect`
// (which throws, as the real one does), and the client body (a recorder). The
// stylesheet import is dropped: node cannot load CSS, and it carries no logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPage(user) {
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'loops-gate-'));
  const put = (n, s) => {
    const f = join(dir, n);
    writeFileSync(f, s);
    return pathToFileURL(f).href;
  };
  const auth = put('auth.mjs', `export const getUser = async () => (${JSON.stringify(user)});`);
  const nav = put(
    'nav.mjs',
    `export const redirect = (u) => { const e = new Error('NEXT_REDIRECT:' + u); e.digest = 'NEXT_REDIRECT'; e.url = u; throw e; };`,
  );
  const view = put('view.mjs', `export default function LoopsView() { return null; }`);
  const intro = put('intro.mjs', `export default function LoopsIntro() { return null; }`);
  const src = readFileSync(join(WEB, 'src/app/loops/page.tsx'), 'utf8');
  assert.equal((src.match(/^import '@\/styles\/loops-page\.css';$/gm) ?? []).length, 1, 'the stylesheet import moved');
  const js = ts
    .transpileModule(src.replace(/^import '@\/styles\/loops-page\.css';$/m, ''), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    })
    .outputText.replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${auth}'`)
    .replace(/from ['"]next\/navigation['"]/g, `from '${nav}'`)
    .replace(/from ['"]\.\/LoopsView['"]/g, `from '${view}'`)
    .replace(/from ['"]@\/components\/loops\/LoopsIntro['"]/g, `from '${intro}'`)
    .replace(
      /from ['"]@\/lib\/loops\/availability['"]/g,
      `from '${pathToFileURL(join(WEB, 'src/lib/loops/availability.ts')).href}'`,
    );
  const unknown = [...js.matchAll(/from ['"](@\/[^'"]+|\.\/[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(unknown, [], `page.tsx imports ${unknown.join(', ')}, which this loader does not map`);
  const mod = await import(put('page.mjs', js));
  assert.equal(mod.dynamic, 'force-dynamic', 'the gate reads the session cookie, so the page must be dynamic');
  return mod.default;
}

const ID = '477fb242-695a-4b29-9373-a26b9067a8fa';
const redirectOf = async (fn) => {
  try {
    await fn();
  } catch (e) {
    if (e?.digest === 'NEXT_REDIRECT') return e.url;
    throw e;
  }
  return null;
};

// 2026-11-15: bare /loops signed out is the Download loops PRODUCT PAGE (the top nav offers it
// on every page, the landing included), not a bounce to sign-in. Its sign-in button carries the
// return path instead — asserted in test/two-products-nav.test.mjs on the rendered intro.
test('M10: signed OUT, bare /loops renders the product intro — no redirect, no LoopsView', async () => {
  const Page = await loadPage(null);
  assert.equal(await redirectOf(() => Page({ searchParams: {} })), null);
  const el = await Page({ searchParams: {} });
  assert.equal(el.type.name, 'LoopsIntro', 'a signed-out visitor must never get the signed-in body');
  assert.equal((await Page({})).type.name, 'LoopsIntro');
});

test('M10: signed OUT with ?job, the return trip keeps the song', async () => {
  const Page = await loadPage(null);
  assert.equal(
    await redirectOf(() => Page({ searchParams: { job: ID } })),
    `/login?return_to=${encodeURIComponent(`/loops?job=${ID}`)}`,
  );
});

test('signed IN: no redirect, and a valid ?job reaches the view, lowercased', async () => {
  const Page = await loadPage({ user_id: 'u1', email: 'a@b.c' });
  const el = await Page({ searchParams: { job: ID.toUpperCase() } });
  assert.equal(el.props.initialJobId, ID);
  const none = await Page({});
  assert.equal(none.props.initialJobId, null);
});

test('M11: a ?job that is not exactly a uuid never reaches the view or the return_to', async () => {
  const signedIn = await loadPage({ user_id: 'u1', email: 'a@b.c' });
  const signedOut = await loadPage(null);
  for (const bad of [`${ID}x`, `x${ID}`, `/jobs/${ID}`, '//evil.example', 'not-a-job', [ID, 'x'].join('&job=')]) {
    const el = await signedIn({ searchParams: { job: bad } });
    assert.equal(el.props.initialJobId, null, `accepted ?job=${bad}`);
    // A bad ?job is dropped, so signed out it is just bare /loops: the intro, never a redirect
    // that carries the bad value.
    assert.equal(await redirectOf(() => signedOut({ searchParams: { job: bad } })), null);
    assert.equal((await signedOut({ searchParams: { job: bad } })).type.name, 'LoopsIntro');
  }
  // An array (?job=a&job=b) uses the first value, and only if it is a uuid.
  assert.equal((await signedIn({ searchParams: { job: [ID, 'x'] } })).props.initialJobId, ID);
  assert.equal((await signedIn({ searchParams: { job: ['x', ID] } })).props.initialJobId, null);
});
