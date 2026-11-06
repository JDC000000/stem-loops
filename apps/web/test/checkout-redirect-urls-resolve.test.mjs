// Every URL we hand to a payment provider must resolve to a page that EXISTS.
//
// Why this test exists: `successUrl` pointed at `/billing/success` while the
// only success page is `app/success/page.tsx` -> `/success`. There is no
// `app/billing/` route segment at all (only `app/api/billing/`), and no
// rewrite or redirect covered it, so EVERY paying customer landed on a 404
// the instant they paid. Credits still arrived via the webhook, so nothing
// was lost -- but the 404 hit at the worst possible moment, and the whole
// test suite was green through it, because no test ever asked whether a
// redirect target was a real route.
//
// This test is deliberately about ROUTE EXISTENCE, not about string shape.
// Asserting `successUrl.includes('/success')` would have passed on the broken
// URL too (`/billing/success` contains `/success`). So it resolves each path
// against the App Router's real file layout instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(WEB, 'src/app');

// Resolve a URL path to an App Router page file, honouring route groups
// ("(marketing)") and dynamic segments ("[id]"). Returns the matched file or
// null. Kept dependency-free on purpose: a test that needs Next's resolver to
// run is a test that gets skipped the first time it breaks.
function resolvePage(urlPath) {
  const segments = urlPath.split('/').filter(Boolean);

  const walk = (dir, rest) => {
    if (rest.length === 0) {
      for (const f of ['page.tsx', 'page.ts', 'page.jsx', 'page.js']) {
        if (existsSync(join(dir, f))) return join(dir, f);
      }
      // A route group at the leaf, e.g. app/(shop)/page.tsx
      for (const e of readdirSync(dir)) {
        if (/^\(.+\)$/.test(e) && statSync(join(dir, e)).isDirectory()) {
          const hit = walk(join(dir, e), []);
          if (hit) return hit;
        }
      }
      return null;
    }
    const [head, ...tail] = rest;
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());

    // 1. exact segment
    if (entries.includes(head)) {
      const hit = walk(join(dir, head), tail);
      if (hit) return hit;
    }
    // 2. transparent route groups — they do not consume a segment
    for (const e of entries) {
      if (/^\(.+\)$/.test(e)) {
        const hit = walk(join(dir, e), rest);
        if (hit) return hit;
      }
    }
    // 3. dynamic [slug] / catch-all [...slug]
    for (const e of entries) {
      if (/^\[\.\.\..+\]$/.test(e)) {
        const hit = walk(join(dir, e), []);
        if (hit) return hit;
      }
    }
    for (const e of entries) {
      if (/^\[[^.].*\]$/.test(e)) {
        const hit = walk(join(dir, e), tail);
        if (hit) return hit;
      }
    }
    return null;
  };

  return walk(APP, segments);
}

// Pull every `${origin}/...` template literal out of a route file.
function originUrlPaths(relFile) {
  const src = readFileSync(join(WEB, relFile), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\$\{origin\}(\/[^`'"$\s]*)/g)) {
    // Strip the query string and any {CHECKOUT_SESSION_ID}-style placeholder.
    out.push(m[1].split('?')[0]);
  }
  return [...new Set(out)];
}

const ROUTES_THAT_REDIRECT_USERS = [
  'src/app/api/billing/checkout/route.ts',
  'src/app/api/billing/portal/route.ts',
];

for (const rel of ROUTES_THAT_REDIRECT_USERS) {
  if (!existsSync(join(WEB, rel))) continue;
  test(`${rel}: every \${origin} redirect target is a real page`, () => {
    const paths = originUrlPaths(rel);
    assert.ok(paths.length > 0, `${rel} has no \${origin} URLs — did the pattern change?`);
    for (const p of paths) {
      assert.ok(
        resolvePage(p),
        `${rel} sends users to "${p}", which resolves to no page under src/app. ` +
          `A paying customer would get a 404 here.`,
      );
    }
  });
}

// Guard the resolver itself. A broken resolver that returns truthy for
// everything would make the tests above vacuous — the exact failure mode this
// file exists to prevent.
test('resolvePage: finds a real page and rejects a fake one', () => {
  assert.ok(resolvePage('/success'), '/success should resolve — app/success/page.tsx exists');
  assert.equal(
    resolvePage('/billing/success'),
    null,
    '/billing/success must NOT resolve; if this fails, someone added app/billing/success/ ' +
      'and the original bug is no longer a bug — update this test deliberately.',
  );
  assert.equal(resolvePage('/definitely-not-a-route-xyzzy'), null);
});

// The success page reads `credits` as the PACK SIZE ("20"), not the pack code
// ("credits_20"), so handing it packRaw verbatim silently degrades to the
// generic copy. Pin the contract in both directions.
test('success page credits param contract matches what checkout sends', () => {
  const page = readFileSync(join(APP, 'success/page.tsx'), 'utf8');
  const set = page.match(/new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'success/page.tsx no longer declares its PACKS set — re-pin this contract');
  const accepted = [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const checkout = readFileSync(join(WEB, 'src/app/api/billing/checkout/route.ts'), 'utf8');
  const packCodes = [...checkout.matchAll(/'(credits_\d+)'/g)].map((m) => m[1]);
  assert.ok(packCodes.length > 0, 'checkout route no longer lists credits_* pack codes');

  for (const code of packCodes) {
    const sent = code.replace(/^credits_/, '');
    assert.ok(
      accepted.includes(sent),
      `checkout would send credits=${sent} for ${code}, but success/page.tsx only accepts ` +
        `[${accepted.join(', ')}] — the confirmation would fall back to generic copy.`,
    );
  }
});
