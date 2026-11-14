// The /pricing feature table — the bullets under each plan card.
//
// WHY THIS FILE EXISTS
// --------------------
// Before it, the entire feature table was ungated. A QA sweep changed the
// string 'Stem export' to 'ZZMUTANT export' on two paid tiers and the whole
// suite stayed green, because
//
//   grep "Stem export\|Loop export\|3 songs per day\|Spotify\|SoundCloud\
//        \|24-bit WAV export\|Free forever" apps/web/test/
//
// returned nothing. Every word a visitor read about what they were buying was
// unasserted, which is how the page came to say "3 songs per day" for a 90/mo
// plan and "File uploads only (no link import)" on a $4.99 tier whose free
// tier had link import.
//
// WHAT IT ASSERTS, AND WHAT IT REFUSES TO ASSERT
// ----------------------------------------------
// Two independent things, because either alone is a weak gate:
//
//  (1) The bullets match THE DATA. Not "the string '5 tracks' appears
//      somewhere" — a fragment-presence assertion does not assert the quota is
//      5, it only proves some 5 exists. The quota is read out of the plan row,
//      interpolated into the expected sentence, and the WHOLE sentence is
//      compared. Change the row to 7 and the expectation moves with it; change
//      the COMPONENT's wording and this fails.
//
//      These expectations are written out longhand, NOT built by calling the
//      component's own helpers. Recomputing a value with the same function
//      that produced it proves only that the code applied its own rule — the
//      self-consistency trap that blocked PR #207 twice. quotaLine() is
//      imported in exactly one test below, and only to prove it AGREES with
//      the longhand sentence; every other assertion is against a literal.
//
//  (2) The bullets match WHAT THE APP CAN DELIVER. A page can be perfectly
//      faithful to its database and still lie, which is exactly what happened:
//      plans.export_stems was true, features() rendered it honestly, and at
//      the time no stem-export route existed. So there is a ban list keyed to
//      capabilities that are absent from the repo, and it is applied to the
//      RENDERED BULLETS for every plan row shape, including deliberately
//      hostile rows that set every flag true.
//
// The ban list reads the bullets this module RETURNS, never the component's
// source text, so a comment in page.tsx explaining why a claim is wrong cannot
// turn this file red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');
const PAGE = join(WEB, 'src/app/pricing/page.tsx');
const MIGRATION = join(REPO, 'apps/worker/migrations/034_v3_pricing_model_truth.sql');
const MIGRATION_037 = join(REPO, 'apps/worker/migrations/037_v3_studio_stem_export.sql');

// ---------------------------------------------------------------------------
// Load features() / quotaLine().
//
// They live in src/lib/pricing-copy.ts rather than in the page: a Next.js App
// Router page may only export a fixed set of fields, so exporting them from
// page.tsx compiled under `tsc --noEmit` and then failed `next build` with
// `"quotaLine" is not a valid Page export field`. The module is transpiled and
// imported directly here — no next, no @/lib/db, no client component.
//
// page.tsx is still read as text further down, to check that it uses this
// module and that its FALLBACK catalog has not drifted from the migration.
// ---------------------------------------------------------------------------
const COPY = join(WEB, 'src/lib/pricing-copy.ts');
const pageSrc = readFileSync(PAGE, 'utf8');

const copyJs = ts.transpileModule(readFileSync(COPY, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { features, quotaLine } = await import(
  'data:text/javascript;base64,' + Buffer.from(copyJs).toString('base64')
);

/** Slice a region of a source file, asserting the anchors are unambiguous.
 *  An anchor that stopped matching would otherwise silently test nothing. */
function sliceOnce(src, startAnchor, endAnchor) {
  const nStart = src.split(startAnchor).length - 1;
  const nEnd = src.split(endAnchor).length - 1;
  assert.equal(nStart, 1, `anchor ${JSON.stringify(startAnchor)} must occur exactly once, found ${nStart}`);
  assert.equal(nEnd, 1, `anchor ${JSON.stringify(endAnchor)} must occur exactly once, found ${nEnd}`);
  const a = src.indexOf(startAnchor);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b > a, 'end anchor must follow the start anchor');
  return src.slice(a, b);
}

test('the pricing page renders its bullets from this module', () => {
  // Without this, the page could keep a private copy of features() and every
  // assertion below would be testing a module nobody renders.
  assert.match(pageSrc, /from '@\/lib\/pricing-copy'/);
  assert.match(pageSrc, /\{features\(p\)\.map\(/);
  assert.doesNotMatch(pageSrc, /function features\s*\(/, 'page must not define its own features()');
});

// ---------------------------------------------------------------------------
// The plan catalog, parsed out of migration 034 — the source of truth.
//
// Parsed rather than retyped so this file cannot drift from the migration. A
// retyped copy would make "the page matches the plan" a tautology between two
// hand-written literals.
// ---------------------------------------------------------------------------
const migrationSql = readFileSync(MIGRATION, 'utf8');

function planFromMigration(code) {
  // ('free', 'Free', 0, 5, ARRAY['youtube']::text[], false, false, true)
  const re = new RegExp(
    `\\(\\s*'${code}'\\s*,\\s*'[^']*'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*ARRAY\\[([^\\]]*)\\]::text\\[\\]\\s*,\\s*(true|false)\\s*,\\s*(true|false)\\s*,\\s*(true|false)\\s*\\)`,
  );
  const m = migrationSql.match(re);
  assert.ok(m, `migration 034 must carry a '${code}' row this regex can read`);
  const services = m[3].trim()
    ? m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : [];
  return {
    code,
    price_cad_cents: Number.parseInt(m[1], 10),
    monthly_job_quota: Number.parseInt(m[2], 10),
    services,
    export_stems: m[4] === 'true',
    export_wav24: m[5] === 'true',
    active: m[6] === 'true',
  };
}

const PLANS_034 = {
  free: planFromMigration('free'),
  pro: planFromMigration('pro'),
  studio: planFromMigration('studio'),
};

// Migration 037 then flips ONE flag with a plain UPDATE (studio export_stems
// -> true). The effective catalog is 034's rows with 037's UPDATEs applied on
// top, in the order the runner applies them. Parsed, not retyped, for the same
// reason as above. Comments are stripped first so the prose in 037's header
// cannot be mistaken for a statement; the parse must find at least one UPDATE
// and must account for every UPDATE in the file, so a reworded 037 cannot
// silently become a no-op here.
const migration037Sql = readFileSync(MIGRATION_037, 'utf8').replace(/--[^\n]*/g, '');
const UPDATE_RE =
  /UPDATE\s+public\.plans\s+SET\s+(export_stems|export_wav24)\s*=\s*(true|false)\s+WHERE\s+code\s*=\s*'(\w+)'\s*;/g;
const updates037 = [...migration037Sql.matchAll(UPDATE_RE)].map((m) => ({
  column: m[1], value: m[2] === 'true', code: m[3],
}));
const PLANS = structuredClone(PLANS_034);
for (const u of updates037) {
  assert.ok(PLANS[u.code], `037 updates unknown plan '${u.code}'`);
  PLANS[u.code][u.column] = u.value;
}

test('migration 037 is parsed completely: every UPDATE in it was applied above', () => {
  const statements = (migration037Sql.match(/\bUPDATE\b/gi) ?? []).length;
  assert.ok(updates037.length > 0, '037 must carry an UPDATE this parser can read');
  assert.equal(updates037.length, statements,
    `037 has ${statements} UPDATE statement(s) but only ${updates037.length} matched the parser`);
});

test('effective catalog (034 + 037): stem export on Studio only, 24-bit WAV export on nobody', () => {
  // Jon, 2026-11-12: $12 Studio gets stem export, $4.99 Pro and Free do not.
  // Literals on purpose, as in (0) below.
  assert.deepEqual(
    Object.fromEntries(Object.entries(PLANS).map(([c, p]) => [c, p.export_stems])),
    { free: false, pro: false, studio: true },
  );
  for (const [code, p] of Object.entries(PLANS)) {
    assert.equal(p.export_wav24, false, `${code}.export_wav24`);
  }
  // And 037 really is what moved it: 034 alone left Studio false.
  assert.equal(PLANS_034.studio.export_stems, false);
});

// ---------------------------------------------------------------------------
// (0) The approved model, pinned. These are Jon's decided numbers, so they are
//     literals here on purpose: if the migration drifts from them, that is the
//     thing to catch, and a parsed expectation could not catch it.
// ---------------------------------------------------------------------------
test('migration 034 carries the approved quotas and prices', () => {
  assert.equal(PLANS.free.monthly_job_quota, 5);
  assert.equal(PLANS.pro.monthly_job_quota, 50);
  assert.equal(PLANS.studio.monthly_job_quota, 150);
  assert.equal(PLANS.free.price_cad_cents, 0);
  assert.equal(PLANS.pro.price_cad_cents, 499);
  assert.equal(PLANS.studio.price_cad_cents, 1200);
});

test('no plan sits at or above the retired unlimited sentinel', () => {
  for (const [code, p] of Object.entries(PLANS)) {
    assert.ok(
      p.monthly_job_quota < 100000,
      `${code} must carry a real monthly bound, got ${p.monthly_job_quota}`,
    );
    assert.ok(p.monthly_job_quota > 0, `${code} quota must be positive`);
  }
});

test("the page's FALLBACK array matches migrations 034 + 037 field for field", () => {
  // The degraded-mode fallback is a second copy of the catalog. When it drifts,
  // a Postgres outage silently serves the OLD prices — the failure mode is
  // invisible precisely when nobody is watching.
  const fallback = sliceOnce(pageSrc, 'const FALLBACK: Plan[] = [', '// Fallback for the one-time credit SKUs');
  for (const [code, p] of Object.entries(PLANS)) {
    const row = fallback.match(new RegExp(`\\{[^}]*code: '${code}'[^}]*\\}`));
    assert.ok(row, `FALLBACK must contain a '${code}' row`);
    const txt = row[0];
    assert.match(txt, new RegExp(`monthly_job_quota: ${p.monthly_job_quota}\\b`),
      `FALLBACK ${code} quota must be ${p.monthly_job_quota}: ${txt}`);
    assert.match(txt, new RegExp(`price_cad_cents: ${p.price_cad_cents}\\b`),
      `FALLBACK ${code} price must be ${p.price_cad_cents}: ${txt}`);
    assert.match(txt, new RegExp(`export_stems: ${p.export_stems}\\b`),
      `FALLBACK ${code} export_stems must be ${p.export_stems}: ${txt}`);
    assert.match(txt, new RegExp(`export_wav24: ${p.export_wav24}\\b`),
      `FALLBACK ${code} export_wav24 must be ${p.export_wav24}: ${txt}`);
  }
});

// ---------------------------------------------------------------------------
// (1) The bullets, pinned whole, against the data.
// ---------------------------------------------------------------------------

// Written longhand. NOT generated by the component's helpers.
const EXPECTED = {
  free: [
    '5 tracks converted to play-along per month',
    'Link import: YouTube',
    'Loop download — 24-bit WAV',
  ],
  pro: [
    '50 tracks converted to play-along per month',
    'Works with audio files you upload',
    'Loop download — 24-bit WAV',
  ],
  studio: [
    '150 tracks converted to play-along per month',
    'Works with audio files you upload',
    'Loop download — 24-bit WAV',
  ],
};

for (const code of ['free', 'pro', 'studio']) {
  test(`features(${code}) renders exactly the approved bullets, in order`, () => {
    assert.deepEqual(features(PLANS[code]), EXPECTED[code]);
  });
}

test('the quota sentence is DERIVED from monthly_job_quota, not typed', () => {
  // The defect this replaces: the sentence sat behind a `>= 100000` test, so
  // changing the quota column left the page saying "3 songs per day". Proof
  // that the number now follows the column: feed quotas the catalog does not
  // contain and the sentence must move. 1 also pins the singular.
  for (const [quota, expected] of [
    [1, '1 track converted to play-along per month'],
    [7, '7 tracks converted to play-along per month'],
    [4242, '4242 tracks converted to play-along per month'],
  ]) {
    const bullets = features({ ...PLANS.pro, monthly_job_quota: quota });
    assert.equal(bullets[0], expected);
  }
});

test('quotaLine agrees with the longhand sentence (and is not how it was built)', () => {
  // The only place the component's own helper is consulted, and only to check
  // it against a literal written independently of it.
  assert.equal(quotaLine({ ...PLANS.free, monthly_job_quota: 5 }),
    '5 tracks converted to play-along per month');
  assert.equal(EXPECTED.free[0], '5 tracks converted to play-along per month');
});

test('the period is the month the enforcement actually uses', () => {
  // checkMonthlyQuota() compares entitlements.jobs_used to
  // plans.monthly_job_quota and rolls on period_end — a calendar month. The
  // old copy said "per day", which no code anywhere implements.
  for (const code of ['free', 'pro', 'studio']) {
    assert.match(features(PLANS[code])[0], /\bper month$/);
    assert.doesNotMatch(features(PLANS[code]).join(' | '), /\bper day\b|\/day\b|\bdaily\b/i);
  }
});

test('an unimplemented service in the data is still not advertised', () => {
  // Defence in depth over migration 034: even if a plans row re-acquires
  // spotify/soundcloud, the page must not name them — and must not print the
  // raw code either, which the old `?? s` fallback would have done.
  const bullets = features({ ...PLANS.free, services: ['youtube', 'spotify', 'soundcloud'] });
  const joined = bullets.join(' | ');
  assert.match(joined, /Link import: YouTube$|Link import: YouTube \|/);
  assert.doesNotMatch(joined, /spotify|soundcloud/i);
});

test('a plan with no implemented service claims no link import, and no loss', () => {
  const bullets = features({ ...PLANS.pro, services: ['spotify'] });
  assert.deepEqual(bullets, [
    '50 tracks converted to play-along per month',
    'Works with audio files you upload',
    'Loop download — 24-bit WAV',
  ]);
  // And specifically NOT the old negative bullet, which advertised paying
  // $4.99 as giving up a feature the free tier has.
  assert.doesNotMatch(bullets.join(' | '), /no link import|uploads only/i);
});

// ---------------------------------------------------------------------------
// (2) The bullets against what the app can deliver.
// ---------------------------------------------------------------------------

// Each entry: [regex, why this claim is not deliverable today].
const UNDELIVERABLE = [
  [/\bstem export\b/i,
   'the gated API route exists (GET /api/jobs/[id]/download, Studio only) but nothing in the UI calls it, so a buyer could not find it; add the bullet in the change that ships the download button'],
  [/\bexport (?:your |the )?stems\b/i, 'same — no UI surfaces the stem download'],
  [/\bstems?\s*\.?\s*zip\b/i, 'nothing in the repo produces a stems archive'],
  [/\bunlimited\b/i,
   'every plan carries a finite monthly_job_quota and checkMonthlyQuota() enforces it'],
  [/\bspotify\b/i, 'no Spotify downloader, route or error code exists'],
  [/\bsoundcloud\b/i, 'no SoundCloud downloader, route or error code exists'],
  [/\b(?:apple music|tidal|deezer|bandcamp)\b/i, 'not implemented'],
  [/\b3 songs per day\b/i, 'no per-day limit is implemented anywhere'],
  [/\bper day\b|\/day\b/i, 'the quota period is a calendar month'],
  [/\bfree forever\b/i, 'no such commitment is encoded anywhere'],
  [/\b24-bit WAV export\b/i,
   'it is not a paid export: every tier gets 24-bit WAV loops, so naming it an "export" tier feature overstates what a paid plan adds'],
];

// Row shapes to render, including hostile ones. If a flag being true can make
// the page claim an absent capability, one of these finds it.
const ROWS = [
  ['catalog free', PLANS.free],
  ['catalog pro', PLANS.pro],
  ['catalog studio', PLANS.studio],
  ['all flags true', { ...PLANS.studio, export_stems: true, export_wav24: true }],
  ['stems flag true', { ...PLANS.pro, export_stems: true }],
  ['wav24 flag true', { ...PLANS.pro, export_wav24: true }],
  ['sentinel quota', { ...PLANS.pro, monthly_job_quota: 100000 }],
  ['every service listed', { ...PLANS.free, services: ['youtube', 'spotify', 'soundcloud', 'tidal'] }],
];

for (const [label, row] of ROWS) {
  test(`bullets claim nothing undeliverable — ${label}`, () => {
    const bullets = features(row);
    const joined = bullets.join(' | ');
    for (const [re, why] of UNDELIVERABLE) {
      assert.doesNotMatch(joined, re, `bullets claim ${re}, but ${why}. Bullets: ${joined}`);
    }
  });
}

test('turning export flags on cannot add a bullet', () => {
  // export_stems is true on Studio (037) and the route that honours it exists,
  // but no UI calls that route yet, so the bullets stay flag-blind on purpose:
  // the bullet ships with the download button, not with the API. This proves
  // the page is quiet by construction, not because of the data. When the button
  // lands, change features() AND this test together.
  const base = features(PLANS.pro);
  assert.deepEqual(features({ ...PLANS.pro, export_stems: true }), base);
  assert.deepEqual(features({ ...PLANS.pro, export_wav24: true }), base);
  assert.deepEqual(
    features({ ...PLANS.pro, export_stems: true, export_wav24: true }), base);
});

test('every bullet is non-empty and has no unresolved interpolation', () => {
  for (const [, row] of ROWS) {
    for (const b of features(row)) {
      assert.ok(typeof b === 'string' && b.trim().length > 0, `empty bullet in ${JSON.stringify(row)}`);
      assert.doesNotMatch(b, /undefined|NaN|\[object|\$\{/, `malformed bullet: ${b}`);
    }
  }
});

// ---------------------------------------------------------------------------
// (3) The page must not offer two different free amounts.
// ---------------------------------------------------------------------------
test('/pricing does not render the 3-song trial banner beside the Free card', () => {
  // The banner said "First 3 songs free with signup" to every signed-out
  // viewer, directly above a Free card offering more, for free, with no
  // account. Two free amounts in one viewport is the contradiction this whole
  // change exists to end.
  assert.doesNotMatch(pageSrc, /songs free with signup/i);
  assert.doesNotMatch(pageSrc, /showTrialBanner/);
  assert.doesNotMatch(pageSrc, /\breadTrial\b/);
});

test('the page header makes no claim the tiers contradict', () => {
  const header = sliceOnce(pageSrc, '<h1', '{degraded && (');
  for (const re of [/\bunlimited\b/i, /\bfree forever\b/i, /\bhigher-quality exports?\b/i]) {
    assert.doesNotMatch(header, re, `page header matches ${re}`);
  }
});
