// Copy audit v1.3.1 leftovers (2026-11-14): CA-3 (F23), CA-7 (A-02), CA-8 (A-05/A-07),
// CA-9 (D-03), CA-11 (F72) and CA-15 (StartTrialButton). Each test pins one item so that
// reverting it goes red. The landing items read the RENDERED page, for the reasons given in
// test/helpers/render-landing-page.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { landingPage } from './helpers/render-landing-page.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(WEB, 'src', p);
const read = (p) => readFileSync(SRC(p), 'utf8');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const RENDER = await landingPage();
const flatten = (s) => s.replace(/<[^>]*>/g, ' ').replace(/[\s ]+/g, ' ').trim();

const MAX_TRACK_SEC = Number(read('lib/play/types.ts').match(/export const MAX_TRACK_SEC = ([\d_]+)/)[1].replace(/_/g, ''));
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

// ── CA-3 / F23 (Jon approved 2026-11-13, unblocked by #220) ─────────────────────────────

test('F23: the FAQ says who can fetch a job by its link, matching the privacy notice after #220', () => {
  const m = RENDER.html.match(/<summary>What happens to my files\?<\/summary>\s*<p>([\s\S]*?)<\/p>/);
  assert.ok(m, 'the rendered FAQ has no "What happens to my files?" entry');
  const answer = flatten(m[1]);
  assert.match(
    answer,
    /Anyone holding the link to a job you start without an account can fetch its audio and stems, so don’t pass that link around\./,
  );
  assert.match(answer, /A job you start while signed in opens only for your account\./);
  assert.doesNotMatch(answer, /Anyone with a job’s link can open it/, 'the pre-#220 sentence is gone');
  // The privacy notice says the same two things (its "Links to jobs" section).
  const privacy = flatten(read('app/(landing)/privacy/page.tsx'));
  assert.match(privacy, /anyone holding the link can fetch its audio and stems, with no account at all/);
  assert.match(privacy, /A job you start while signed in can be opened only by your account\./);
});

// ── CA-7 / A-02: meta description length ────────────────────────────────────────────────

/** The `description:` template literal(s) of a metadata export, with their ${…} filled in. A
 *  description switched by the DB-17 chords flag (`CHORDS_LINE_SHOWN ? `…` : `…``, review round
 *  2) yields BOTH branches, so each must fit. */
const metaDescriptions = (rel) => {
  // A4: the switch is a runtime function now, so a switched description reads `… = (): string => chordsLineShown()\n ? `…` : `…`` (site.ts)
  // or a `get description() { return chordsLineShown() ? `…` : `…`; }` getter (pages.ts).
  const m = read(rel).match(/(?:\bdescription:|\bsiteDescription\s*=\s*\(\):\s*string\s*=>|\bget description\(\)\s*\{\s*return)\s*(?:chordsLineShown\(\)\s*\?\s*)?`([^`]*)`(?:\s*:\s*`([^`]*)`)?/);
  assert.ok(m, `${rel} has no template-literal metadata description`);
  return [m[1], m[2]].filter((x) => x !== undefined).map((lit) => {
    const fills = [...lit.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim());
    for (const f of fills) assert.match(f, /^(?:MAX_TRACK_MIN|Math\.floor\(MAX_TRACK_SEC \/ 60\))$/, `${rel} fills ${f}`);
    return lit.replace(/\$\{[^}]*\}/g, String(MAX_TRACK_MIN));
  });
};

// The landing description now comes from the SEO page registry (#271), entry '/'. The root
// layout's default description moved to SITE_DESCRIPTION in lib/seo/site.ts (QA C-12, so the
// DB-17 chords switch reaches it); the layout must read it from there.
test('A-02: app/layout.tsx takes its default description from siteDescription()', () => {
  // A4: generateMetadata calls it, so the DB-17 runtime switch is read per request.
  const src = read('app/layout.tsx');
  assert.match(src, /import \{ siteDescription \} from '@\/lib\/seo\/site';/);
  assert.match(src, /\bdescription:\s*siteDescription\(\),/);
  assert.match(src, /export function generateMetadata\(\)/);
});
for (const rel of ['lib/seo/pages.ts', 'lib/seo/site.ts']) {
  test(`A-02: ${rel} meta description fits a search snippet (<= 160 characters)`, () => {
    for (const d of metaDescriptions(rel)) {
      assert.ok(d.length <= 160, `${d.length} characters: ${JSON.stringify(d)}`);
      assert.ok(d.length >= 70, `too short to describe the page: ${JSON.stringify(d)}`);
      assert.match(d, new RegExp(`Uses the first ${MAX_TRACK_MIN} minutes of any song`));
    }
  });
}

// ── CA-8 / A-05, A-07: the Cut instruction is said once, and it is true ───────────────
// Since #277 the job page shows no loops (Story 6.1): they live on /loops, reached by the
// "Download loops" nav item. So "press Cut below the player" is FALSE and must not come back.
// Since 2026-11-15 the landing is the Play along page only, so the one Cut instruction moved
// to the Download loops intro (components/loops/LoopsIntro.tsx) and the landing says none.

test('A-05/A-07: the landing no longer tells you to press Cut; the Download loops intro does, once', async () => {
  for (const text of [RENDER.textSpaced, RENDER.textTight]) {
    assert.equal((text.match(/below the player/gi) ?? []).length, 0, 'the job page no longer shows loops (#277)');
    assert.equal((text.match(/press Cut/gi) ?? []).length, 0, 'the landing sells Play along only (2026-11-15)');
  }
  assert.ok(!/<section[^>]*id="loops"/.test(RENDER.html), 'the landing still has a #loops section');
  const intro = flatten(read('components/loops/LoopsIntro.tsx'));
  assert.equal((intro.match(/press Cut/gi) ?? []).length, 2, 'lede + step 3, and nowhere else');
  assert.match(intro, /Pick the song and press Cut to make the WAV files\./);
  assert.doesNotMatch(intro, /below the player/i);
});

// ── CA-9 / D-03: error-copy.ts is a straight-quote file ─────────────────────────────────

test('D-03: lib/error-copy.ts has no curly apostrophes among its straight-quoted strings', () => {
  const src = read('lib/error-copy.ts');
  assert.doesNotMatch(src, /[‘’]/, 'use a straight apostrophe in a double-quoted string');
  assert.match(src, /"You've used this month's allowance on your plan\./);
  assert.match(src, /"We couldn't finish this song\. Try another file\."/);
});

// ── CA-11 / F72: RATE_LIMITED says which of its two causes refused you ─────────────────

const ERRCOPY = await import(dataUrl(toJs(read('lib/error-copy.ts'))));

test('F72: the two RATE_LIMITED sentences exist, differ, and do not borrow each other\'s reason', () => {
  const per = ERRCOPY.RATE_LIMITED_PER_CLIENT_MSG;
  const ceiling = ERRCOPY.RATE_LIMITED_SPEND_CEILING_MSG;
  assert.equal(per, "You're sending requests too fast. Wait a minute and try again.");
  assert.notEqual(per, ceiling);
  assert.doesNotMatch(per, /capacity|busy|on our end/i);
  assert.doesNotMatch(ceiling, /too fast|going a bit fast|you've hit/i);
  assert.match(ceiling, /on our end/);
  assert.doesNotMatch(ceiling, /on our side/, 'brand tone: "on our end"');
  assert.match(ceiling, /not something you did/i);
});

test('F72: no route or player still sends the old two-causes-in-one sentence', () => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(SRC(''));
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /going a bit fast/, `${f} still says "going a bit fast"`);
  }
});

test('F72: the stems route literal is the per-client sentence from error-copy.ts', () => {
  const m = read('app/api/jobs/[id]/stems/route.ts').match(/const RATE_LIMIT_MSG = "([^"]*)";/);
  assert.ok(m, 'the stems route keeps its RATE_LIMIT_MSG literal');
  assert.equal(m[1], ERRCOPY.RATE_LIMITED_PER_CLIENT_MSG);
});

test('F72: admission.ts routes the spend ceiling to its own result, not the per-client one', () => {
  const src = read('lib/admission.ts');
  assert.match(src, /spendCeilingUsd\(\)\) return SPEND_CEILING;/);
  assert.match(src, /reason: 'spend_ceiling',\s*message: RATE_LIMITED_SPEND_CEILING_MSG/);
  assert.match(src, /reason: 'per_client',\s*message: RATE_LIMITED_PER_CLIENT_MSG/);
});

// ── CA-15: StartTrialButton.tsx had no caller and is deleted ────────────────────────────

test('CA-15: StartTrialButton.tsx is gone and nothing imports it', () => {
  assert.equal(existsSync(SRC('app/trial/StartTrialButton.tsx')), false);
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(SRC(''));
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /import[^;]*StartTrialButton/, f);
});

// ── #498: the tone guide no longer approves "tracks" as the limits / billing unit ──────

test('#498: BRAND-TONE.md counts songs for limits and billing, and no longer lists "free tracks this month"', () => {
  const tone = readFileSync(join(WEB, '..', '..', 'docs', 'seo', 'BRAND-TONE.md'), 'utf8');
  assert.doesNotMatch(tone, /free tracks this month|\d+ tracks a month|one uploaded track/);
  assert.match(tone, /\| \*\*song\*\* \|[^\n]*"5 songs a month", "free songs this month"/);
  assert.match(tone, /\| \*\*track\*\* \| Never the unit for limits or billing/);
});

// ── #512: the "track" leftovers #503 missed (credits copy, tone-guide error example, SEO plan) ──
// Noun-only: "song" is the unit for limits and billing (BRAND-TONE.md glossary, #497/#498).
// The numbers, prices and plan names in these sentences are pinned unchanged.

test('#512: the pricing Credits lede counts one uploaded song, not a track', () => {
  const src = read('app/pricing/page.tsx');
  assert.match(
    src,
    /<p className="pr-lede">One credit is one uploaded song on the Free plan\. Credits never expire\.<\/p>/,
  );
  assert.doesNotMatch(src, /uploaded track/);
});

test('#512: the credit-pack receipt note counts one uploaded song, not a track (rendered)', async () => {
  const sharedUrl = dataUrl(toJs(read('lib/emails/templates/shared.ts')));
  const js = toJs(read('lib/emails/templates/receipt.ts'))
    .replace(/from ['"]@\/lib\/billing\/types['"]/g, `from '${dataUrl('export {};')}'`)
    .replace(/from ['"]\.\/shared['"]/g, `from '${sharedUrl}'`);
  const { renderReceipt } = await import(dataUrl(js) + '#512');
  const pack = renderReceipt({ amount_cad_cents: 500, plan_or_pack_label: '20 credits', invoice_url: null, kind: 'credit_pack', paid_on: '2026-11-13T10:00:00Z' });
  assert.match(pack.text, /Credits never expire\. Each one covers one uploaded song on the Free plan\./);
  assert.doesNotMatch(pack.text + pack.html, /uploaded track/);
});

test('#512: BRAND-TONE.md error examples say "song", in both places', () => {
  const tone = readFileSync(join(WEB, '..', '..', 'docs', 'seo', 'BRAND-TONE.md'), 'utf8');
  const example = '"This song is too short or has no steady beat. Try a longer song with a clear beat."';
  assert.equal(tone.split(example).length - 1, 2, 'rule 2 "Name one cause" + the Errors row of the tone table');
  assert.doesNotMatch(tone, /This track is too short|Try a longer track/);
});

test('#512: SEO-AIO-PLAN.md states our free limit in songs (§2 A3, §4.0 rule, §4.2 fact table)', () => {
  const plan = readFileSync(join(WEB, '..', '..', 'docs', 'seo', 'SEO-AIO-PLAN.md'), 'utf8');
  assert.match(plan, /Ours, free: six stems, including guitar and keys; also 5 songs a month, the same cap/);
  assert.match(plan, /"free: 5 songs a month", "six stems free"/);
  assert.match(plan, /\| Free limits \| \*\*5 songs a calendar month\*\*/);
  assert.doesNotMatch(plan, /\d+ tracks a month|\| Free limits \| \*\*\d+ tracks/);
});
