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

/** The `description:` template literal of a metadata export, with its one ${…} filled in. */
const metaDescription = (rel) => {
  const m = read(rel).match(/\bdescription:\s*`([^`]*)`/);
  assert.ok(m, `${rel} has no template-literal metadata description`);
  const fills = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim());
  for (const f of fills) assert.match(f, /^(?:MAX_TRACK_MIN|Math\.floor\(MAX_TRACK_SEC \/ 60\))$/, `${rel} fills ${f}`);
  return m[1].replace(/\$\{[^}]*\}/g, String(MAX_TRACK_MIN));
};

for (const rel of ['app/(landing)/page.tsx', 'app/layout.tsx']) {
  test(`A-02: ${rel} meta description fits a search snippet (<= 160 characters)`, () => {
    const d = metaDescription(rel);
    assert.ok(d.length <= 160, `${d.length} characters: ${JSON.stringify(d)}`);
    assert.ok(d.length >= 70, `too short to describe the page: ${JSON.stringify(d)}`);
    assert.match(d, new RegExp(`Uses the first ${MAX_TRACK_MIN} minutes of any song`));
  });
}

// ── CA-8 / A-05, A-07: "Press Cut below the player" is said once ───────────────────────

test('A-05/A-07: the page tells you to press Cut below the player exactly once', () => {
  for (const text of [RENDER.textSpaced, RENDER.textTight]) {
    assert.equal((text.match(/press Cut below the player/gi) ?? []).length, 1, 'said once, in the loops section');
  }
  const loops = RENDER.html.match(/<section[^>]*id="loops"[\s\S]*?<\/section>/);
  assert.ok(loops, 'the rendered page has a #loops section');
  assert.match(flatten(loops[0]), /Press Cut below the player to make the WAV files\./);
});

// ── CA-9 / D-03: error-copy.ts is a straight-quote file ─────────────────────────────────

test('D-03: lib/error-copy.ts has no curly apostrophes among its straight-quoted strings', () => {
  const src = read('lib/error-copy.ts');
  assert.doesNotMatch(src, /[‘’]/, 'use a straight apostrophe in a double-quoted string');
  assert.match(src, /"You've used this month's allowance on your plan\./);
  assert.match(src, /"We couldn't finish this track\. Try another file\."/);
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
