// Terms copy gate.
//
// This page replaced one that made claims the code did not support, so every assertion below
// is tied to the file that makes it true. If a claim here stops being true, the named file is
// where it broke — and if that file changes, this gate is the thing that should go red.
//
// Asserted on RENDERED OUTPUT, never on source text: a source-text assertion is satisfied by
// a comment, a string literal, a template or a regex, and this repo has been bitten by each.
// See test/helpers/render-landing-page.mjs for the full argument and for the three rendering
// channels that remain uncovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingPage, renderPage } from './helpers/render-landing-page.mjs';
import { assertNoBannedClaims, assertSays } from './legal-copy-shared.mjs';
import { MAX_TRACK_SEC } from '../src/lib/play/types.ts';

const TERMS = 'app/(landing)/terms/page.tsx';
const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker');

/**
 * Python with its docstrings, its string literals and its `#` comments removed, so that an
 * assertion about what the worker DOES cannot be satisfied by prose about what it does.
 *
 * Order matters: triple-quoted blocks first (a docstring may contain a `#`), then
 * single-line strings (a string may contain a `#`), then comments. Crude on purpose -- it
 * backs presence checks, not a parse -- and `the stripper itself is checked` below proves it
 * is actually removing those three things rather than silently returning the source intact.
 */
const pythonCodeOnly = (src) =>
  src
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, ' ')
    .replace(/#[^\n]*/g, ' ');

const workerCode = (rel) => pythonCodeOnly(readFileSync(join(WORKER, 'src/worker', rel), 'utf8'));

/** The literal assigned to a module-level Python constant, as a number. */
const pyConst = (code, name) => {
  const m = code.match(new RegExp(`^${name}\\s*=\\s*([\\d.]+)`, 'm'));
  assert.ok(m, `${name} is no longer a module-level literal in the worker`);
  return Number(m[1]);
};

test('terms: the four banned sentences match nothing in text or metadata', async () => {
  assertNoBannedClaims(assert, await renderPage(TERMS), 'terms');
});

test('terms: the account-rule fragments are still present', async () => {
  const page = await renderPage(TERMS);
  // TRUE: src/app/api/jobs/route.ts has ZERO 401s and an anonymous INSERT branch that omits
  // user_id (:183-190); src/app/api/uploads/route.ts never calls getUser(); and
  // src/components/landing/ToolForm.tsx has no client-side auth gate.
  assertSays(assert, page, 'You can start a job without an account', 'terms');
  // TRUE: src/app/jobs/[id]/page.tsx:32-33 — getUser() then redirect('/login?return_to=…').
  assertSays(assert, page, 'You need an account to open the player', 'terms');
});

// ─────────────────────────── the duration claim ───────────────────────────
//
// WHAT WAS HERE BEFORE, AND WHY IT WAS THE WRONG SHAPE.
// This was two `assertSays` calls — 'Tracks up to 5 minutes' and 'Longer tracks are not
// accepted' — with a comment arguing that both were true. The comment's own argument named
// two paths, the browser probe in src/lib/upload-duration.ts and the worker's re-probe, and
// BOTH of those are the UPLOAD path. The link path is a third path and it was never checked:
// `_max_upload_duration_sec()` had exactly ONE caller in the whole worker, inside
// `_prepare_upload_source`, and `grep -rn duration src/worker/downloader/` returned nothing.
// So a pasted 10-minute YouTube link was accepted, separated on Replicate at $0.0014 the
// GPU-second over its full length, given a `too_long` chord tombstone, and only then refused
// by the player. 'Longer tracks are not accepted' was false, and because the gate asserted
// the fragment's PRESENCE, correcting the page to the truth turned the suite red. The gate
// did not merely miss the falsehood; it held it in place.
//
// A fragment's presence says nothing about whether the sentence containing it is true. These
// three tests read the code the sentence depends on instead:
//   • the FIGURE is imported from the constant and compared, and the worker's own two
//     ceilings are read out of pipeline.py and compared to it, so no single env var, page
//     edit or worker edit can move one of the four without failing here;
//   • the REFUSAL is asserted as an ordering fact over comment-stripped worker source —
//     both input paths reach their duration gate before the first billed call;
//   • the two PAGES are compared to each other, because the live contradiction that exposed
//     all of this was `/` saying one thing while `/terms`, the legal page, said another.
// The behavioural half — that the refusal actually fires — cannot run here, because this
// suite is node:test and the pipeline is Python. It lives in
// apps/worker/tests/test_link_duration_cap.py, which drives `_run_pipeline` on a link job
// with an over-length staged WAV and asserts `submit_or_reattach` is never called. Its
// existence is asserted below so that deleting it is not a silent way back to a green suite.

test('terms: the duration figure is the one ceiling, in all four places that carry it', async () => {
  const page = await renderPage(TERMS);
  const minutes = Math.floor(MAX_TRACK_SEC / 60);

  // (1) The page, against the IMPORTED constant. Not a hard-coded '5': if MAX_TRACK_SEC
  //     moves and the page does not, the expected string moves with the constant and this
  //     fails — which is the drift a numeric gate written as source text cannot see.
  assertSays(assert, page, `Tracks up to ${minutes} minutes`, 'terms');

  // (2) and (3) The worker's two ceilings, read from pipeline.py. The page promises a length
  //     the WORKER has to enforce, so the page's number is only true while the worker agrees.
  //     U6: MAX_UPLOAD_DURATION_SEC is a Fly env var, and nothing in any test suite can read
  //     Fly's environment — this pins the DEFAULT the code ships with, which is the most a
  //     test can do and is stated as exactly that in the PR that added it.
  const pipeline = workerCode('pipeline.py');
  assert.equal(
    pyConst(pipeline, 'MAX_UPLOAD_DURATION_SEC_DEFAULT'), MAX_TRACK_SEC,
    'the worker would separate a track longer than /terms says it accepts',
  );
  assert.equal(
    pyConst(pipeline, 'CHORDS_MAX_AUDIO_SEC_DEFAULT'), MAX_TRACK_SEC,
    'the page says the chord track stops at the same length; it no longer does',
  );
});

test('terms: the sentence states what holds at any cap, and does not promise a refusal', async () => {
  const page = await renderPage(TERMS);
  // "supported", not "accepted", and no "refused before separation runs". An earlier cut said
  // the latter, unconditionally, and it was false three ways: (a) for a link whose length
  // could not be read the run still reached Replicate (fixed in the worker since, but the
  // sentence was written before it was); (b) for ANY track between 5 and 10 minutes if the
  // worker's cap is the old 600, because the figure on this page is the WEB constant while
  // the worker reads MAX_UPLOAD_DURATION_SEC from the Fly environment; (c) it describes a
  // refusal at "separation" when the job has already been accepted, 201, and a signed-in
  // free user's trial song consumed. Nothing in this suite can read Fly, so the page says
  // only what the player and the chord track guarantee on their own.
  assertSays(assert, page, 'Longer tracks are not supported', 'terms');
  for (const text of [page.textSpaced, page.textTight]) {
    assert.doesNotMatch(
      text,
      /refused\s*before\s*separation|longer\s*tracks\s*are\s*not\s*accepted/i,
      'a claim about WHEN the worker refuses depends on a Fly env var no test can read',
    );
  }
});

test('terms: the worker source places each input path\'s duration gate before the first billed call (static)', async () => {
  // WHAT THIS CHECKS, SO IT IS NOT READ AS MORE: that, in comment-stripped worker source, the
  // names of the gates occur before `submit_or_reattach` in `_run_pipeline`, and that the
  // Cobalt leg of the downloader is conditioned on a verified length. It is an ordering fact
  // about SOURCE TEXT. It cannot see a gate that fails open, and an earlier version of this
  // test, titled "every input path reaches its duration gate", stayed green while two paths
  // (unknown metadata plus an unmeasurable file; unknown metadata plus Cobalt) reached
  // Replicate with no gate at all. The behaviour is asserted where it can run, against the
  // real chain and a real database, in apps/worker/tests/test_link_money_path_e2e.py.
  const pipeline = workerCode('pipeline.py');

  // `submit_or_reattach` is the first call on this path that spends money. Everything that
  // can refuse an over-length input has to be upstream of it, so the window to assert over
  // is `_run_pipeline` up to that call.
  const run = pipeline.slice(pipeline.indexOf('async def _run_pipeline'));
  assert.ok(run, '_run_pipeline is gone — this gate no longer reads anything');
  // Without this line the gate below can go vacuous while staying green: if the name stops
  // appearing — renamed, wrapped, moved behind a helper — `indexOf` returns -1, `slice(0, -1)`
  // keeps almost the whole function, and "X occurs before the billed call" becomes "X occurs".
  assert.ok(run.includes('submit_or_reattach'), 'the billed call is no longer in _run_pipeline');
  const beforeSpend = run.slice(0, run.indexOf('submit_or_reattach'));

  assert.match(
    beforeSpend, /_prepare_upload_source/,
    'the upload path no longer passes its duration gate before Replicate is called',
  );
  assert.match(
    beforeSpend, /_enforce_link_duration/,
    'the LINK path no longer passes a duration gate before Replicate is called',
  );

  // The Cobalt leg returns a URL and no bytes, so it has no file to measure afterwards; it is
  // only safe behind a length that gate 0c actually READ.
  const downloader = workerCode('downloader/__init__.py');
  assert.match(
    downloader, /not\s+cobalt_unverifiable\s+and\s+fetch_gates\.cobalt_allowed\(\)/,
    'the Cobalt leg is no longer conditioned on a verified length',
  );

  // Both paths must be judged by the SAME accessor. One caller is the state that made the
  // sentence false. FOUR matches: the definition, plus THREE call sites —
  // _prepare_upload_source, _enforce_link_duration, and the cap handed to download_audio
  // that arms gate 0c.
  const uses = pipeline.match(/_max_upload_duration_sec\(\)/g) ?? [];
  assert.ok(
    uses.length >= 4,
    `_max_upload_duration_sec() is used ${uses.length} time(s), expected at least 4; a path ` +
      'has lost its cap, gate 0c has been left unarmed, or a second link-only ceiling exists',
  );

  for (const f of ['test_link_duration_cap.py', 'test_link_money_path_e2e.py']) {
    assert.ok(existsSync(join(WORKER, 'tests', f)), `${f}, which exercises the link refusal, has been deleted`);
  }
});

test('terms and the landing state the same thing about length', async () => {
  // U1: `/` already said "not supported: the chord track and the player both stop there"
  // while `/terms` said "not accepted" full stop. One of the two was false and they were
  // never compared, so the contradiction sat in public across two pages.
  const minutes = Math.floor(MAX_TRACK_SEC / 60);
  for (const [label, page] of [['terms', await renderPage(TERMS)], ['landing', await landingPage()]]) {
    assertSays(assert, page, `up to ${minutes} minutes`, label);
    assertSays(assert, page, 'the chord track and the player both stop there', label);
  }
});

test('terms: the stripper itself is checked, so the two gates above cannot go vacuous', () => {
  // A presence check over "code" is worth nothing if the thing it searches still contains
  // the comments. Checked on a fixture rather than on pipeline.py, so rewording a real
  // comment cannot break it and a broken stripper cannot hide behind one.
  const fixture = [
    'x = 1  # _enforce_link_duration',
    'y = "_enforce_link_duration"',
    "z = '_enforce_link_duration'",
    '"""_enforce_link_duration"""',
    'def _enforce_link_duration(a):',
  ].join('\n');
  const hits = pythonCodeOnly(fixture).match(/_enforce_link_duration/g) ?? [];
  assert.equal(hits.length, 1, 'the stripper left a comment, a string or a docstring standing');
});

test('terms: a fragment of each known 24-hour survivor is still present', async () => {
  const page = await renderPage(TERMS);
  assertSays(assert, page, 'deleted after 24 hours', 'terms');
  // apps/worker/src/worker/cleanup.py:_sweep_expired_jobs tries `DELETE FROM jobs` FIRST and
  // only falls through to `_anonymise_job` on a ForeignKeyViolation. Exactly two foreign keys
  // can raise it: credit_consumption.job_id ON DELETE RESTRICT (migration 013:246) and
  // chord_edits.job_id with no ON DELETE clause (migration 025:39). Every other job row is
  // deleted outright, so the exception is SCOPED, not universal — an earlier draft said "each
  // job" and was wrong in the alarming direction.
  assertSays(assert, page, 'charged a credit', 'terms');
  assertSays(assert, page, 'Every other job is deleted outright', 'terms');
  // The sweep leaves THREE kinds of survivor, not one (see the privacy gate for the
  // derivation). The terms carry the short form and point at the privacy notice for the
  // detail, so both of the other two are named here as well.
  assertSays(assert, page, 'chord corrections you saved', 'terms');
  assertSays(assert, page, 'counters and diagnostics', 'terms');
});

test('terms: metadata is the terms metadata, not another page’s', async () => {
  const page = await renderPage(TERMS);
  // The ban list already runs over metadata. This pins the positive side: a page whose
  // metadata was copied from elsewhere would pass every ban and still mis-describe itself in
  // the one place search results read.
  assert.match(page.metaSpaced, /The short terms for using stem-loops\./);
  assert.match(page.metaSpaced, /\/terms/);
});
