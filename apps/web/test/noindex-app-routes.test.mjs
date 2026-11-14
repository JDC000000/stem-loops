// SEO-02: app routes are noindex.
// The three layouts SEO-02 changes are EXECUTED: .tsx with @/ imports goes through the repo's
// compile() helper, with SignedInChrome stubbed (it is on the helper's allowlist; only `metadata`
// is read). The four pages that were already noindex pull in server-only modules (next/headers,
// the DB), so they are held by a source check instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './helpers/render-chrome.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STUBS = { '@/components/chrome/SignedInChrome': 'export default function SignedInChrome() { return null; }' };

for (const f of ['app/login/layout.tsx', 'app/history/layout.tsx', 'app/account/layout.tsx']) {
  test(`${f}: metadata.robots.index === false`, async () => {
    const [url] = compile([f], STUBS);
    const mod = await import(url);
    assert.equal(mod.metadata?.robots?.index, false);
  });
}

for (const f of ['app/account/page.tsx', 'app/success/page.tsx', 'app/pricing/page.tsx', 'app/jobs/[id]/page.tsx']) {
  test(`${f}: still declares noindex`, () => {
    assert.match(readFileSync(join(SRC, f), 'utf8'), /robots:\s*\{\s*index:\s*false/);
  });
}
