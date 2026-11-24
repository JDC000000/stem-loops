// QA C-12..C-17 (2026-11-18). DB-17: new songs may stop getting chords after 2026-12-05, and the
// ONE switch for that is chordsLineShown() in src/lib/chords-claim.ts — since A4 (2026-11-21) a
// RUNTIME switch read from the CHORDS_CLAIMS environment variable while a page renders. test/p7-copy.test.mjs
// proves the home page obeys it. This file proves EVERY OTHER public surface does:
//
//   1. /help, /terms and /privacy are RENDERED (the repo's rule: test/helpers/render-landing-page.mjs)
//      with CHORDS_CLAIMS=off in the environment for the render, and searched in DOM text (both
//      normalisations), accessible-name attributes, the markup and the page metadata.
//   2. /llms.txt, the welcome email, the site-wide default description, the shared Open Graph
//      image + alt, and the JSON-LD are built from the REAL modules and read with CHORDS_CLAIMS=off
//      set — the same thing the operator will do.
//   3. /privacy keeps its DISCLOSURES with the switch off (Klangio as a processor; the chord data
//      that already exists). Gating the promise must not silently drop the disclosure.
//   4. A source scan: any file under src/ that mentions "chord" must either import the switch or
//      be on ALLOW below, with a reason. A new marketing surface that mentions chords and forgets
//      the switch fails here, before 12-05 makes it false.
//   5. Numeric claims on these surfaces (retention hours/days, the Free monthly songs, the track
//      cap) are checked against the config or migration they come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderPage } from './helpers/render-landing-page.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';
import { RETENTION_HOURS, PAID_RETENTION_GRACE_DAYS, JOB_RETAINED_UNTIL_SQL } from '../src/lib/retention.ts';
import { MAX_TRACK_SEC } from '../src/lib/play/types.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const REPO = join(WEB, '..', '..');
const OFF_ENV = { CHORDS_CLAIMS: 'off' };

test('sanity: the switch is ON by default (no CHORDS_CLAIMS), so every OFF render below is a real flip', async () => {
  const { chordsLineShown } = await import('../src/lib/chords-claim.ts');
  const before = process.env.CHORDS_CLAIMS;
  try {
    delete process.env.CHORDS_CLAIMS;
    assert.equal(chordsLineShown(), true);
    process.env.CHORDS_CLAIMS = 'off';
    assert.equal(chordsLineShown(), false);
  } finally {
    if (before === undefined) delete process.env.CHORDS_CLAIMS; else process.env.CHORDS_CLAIMS = before;
  }
});

/** Run `fn` with the environment variables in `env` set, then restore them. */
async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const page = (p) => renderPage(p, { env: { CHORDS_CLAIMS: undefined } });
const pageOff = (p) => renderPage(p, { env: OFF_ENV });

const HELP = 'app/(landing)/help/page.tsx';
const TERMS = 'app/(landing)/terms/page.tsx';
const PRIVACY = 'app/(landing)/privacy/page.tsx';

const ON = { help: await page(HELP), terms: await page(TERMS), privacy: await page(PRIVACY) };
const OFF = { help: await pageOff(HELP), terms: await pageOff(TERMS), privacy: await pageOff(PRIVACY) };

/** Every 'chord' with 50 chars of context, from every channel of a rendered page. */
function chordHits(r, strip = []) {
  const channels = {
    'text (spaced)': r.textSpaced, 'text (tight)': r.textTight,
    'metadata (spaced)': r.metaSpaced, 'metadata (tight)': r.metaTight,
    // markup, scripts dropped, every tag replaced by ALL its attribute values: attribute text
    // other than aria-label/alt/title (placeholder, data-*, class) lives only here.
    markup: r.html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]*>/g, (tag) => ` ${[...tag.matchAll(/=\s*"([^"]*)"/g)].map((m) => m[1]).join(' ')} `)
      .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' '),
  };
  const out = [];
  for (const [where, raw] of Object.entries(channels)) {
    let t = raw;
    for (const s of strip) t = t.split(s).join(' ');
    for (const m of t.match(/.{0,50}chord.{0,50}/gi) ?? []) out.push(`${where}: ${m}`);
  }
  return out;
}

// ── 1. /help ───────────────────────────────────────────────────────────────────────────────
test('C-12 /help: the switch OFF leaves no chord claim in text, markup or metadata', () => {
  assert.ok(/chord/i.test(ON.help.textSpaced), 'sanity: with the switch on, /help talks about chords');
  assert.match(ON.help.textSpaced, /a chord track running above them/);
  assert.match(ON.help.textSpaced, /How good are the chords\?/);
  assert.deepEqual(chordHits(OFF.help), []);
  // The rest of /help is intact.
  assert.match(OFF.help.textSpaced, /What do I actually get\? A player, in your browser, with the song’s six stems on their own faders\. Mute the guitar/);
  assert.match(OFF.help.textSpaced, /How long does it take\?/);
  assert.match(OFF.help.textSpaced, /What happens to my files\?/);
  assert.doesNotMatch(OFF.help.metaSpaced, /og-image-v4/);
});

// ── 2. /terms ──────────────────────────────────────────────────────────────────────────────
// The one DISCLOSURE /terms keeps: saved chord corrections are real rows (chord_edits) that
// outlive the 24 hours until the account is deleted.
const TERMS_DISCLOSURES = ['any chord corrections you saved'];

test('C-12 /terms: the switch OFF removes the three chord promises and keeps the corrections disclosure', () => {
  for (const re of [/an estimated chord track running above them/, /where the chord track and the player both stop/,
    /The chords are an estimate made from the audio/]) assert.match(ON.terms.textSpaced, re);
  for (const d of TERMS_DISCLOSURES) assert.ok(OFF.terms.textSpaced.includes(d), `/terms dropped the disclosure "${d}"`);
  assert.deepEqual(chordHits(OFF.terms, TERMS_DISCLOSURES), []);
  assert.match(OFF.terms.textSpaced, /with a fader, a mute and a solo on each\. The same job also finds bar-length loops/);
  assert.match(OFF.terms.textSpaced, /which is where the player stops\./);
});

// ── 3. /privacy: gate the promise, keep the disclosure ─────────────────────────────────────
// Exact sentences, rendered. Each is a DISCLOSURE of a processor or of data that exists while any
// song has chords, so DB-17 must leave it alone.
const PRIVACY_DISCLOSURES = [
  'the estimated chord track',                                         // inside the 24-hour deletion
  'the reference numbers for the separation and chord-recognition runs — including the one held by Klangio',
  'Chord corrections you save, kept to improve the chord estimates',
  'Deleting your account removes your account details and your chord corrections.',
  'Klangio estimates the chords. Your audio is sent to them too.',     // the processor list
];

test('C-12 /privacy: the switch OFF removes the promise of chord estimation', () => {
  assert.match(ON.privacy.textSpaced, /one to estimate the chords/);
  assert.match(ON.privacy.textSpaced, /and to have its chords estimated\./);
  assert.deepEqual(chordHits(OFF.privacy, PRIVACY_DISCLOSURES), []);
  assert.match(OFF.privacy.textSpaced, /Your audio goes to outside services to be processed, and every one of them is named below\./);
  assert.match(OFF.privacy.textSpaced, /sent to the processors named below to be separated into stems\./);
});

test('C-12 /privacy: every disclosure, Klangio first, is still there with the switch OFF (and ON)', () => {
  for (const r of [ON.privacy, OFF.privacy]) {
    for (const d of PRIVACY_DISCLOSURES) assert.ok(r.textSpaced.includes(d), `/privacy dropped the disclosure "${d}"`);
  }
  // Klangio stays a named processor, as a list item, in the "Who else handles it" section.
  const who = OFF.privacy.html.match(/<h2>Who else handles it<\/h2>[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.match(who, /<li><strong>Klangio<\/strong> estimates the chords\. Your audio is sent to them too\.<\/li>/);
});

// ── 4. the non-page surfaces: llms.txt, welcome email, shared metadata, JSON-LD ────────────
// The REAL modules, built once; the switch is flipped in the environment, as the operator will.
const GRAPH = buildModuleGraph({
  name: 'chords-surfaces',
  entries: ['lib/seo/llms.ts', 'lib/seo/site.ts', 'lib/seo/pages.ts', 'lib/seo/meta.ts', 'lib/seo/jsonld.ts',
    'lib/emails/templates/welcome.ts'],
});
async function surfaces(flag) {
  const [llms, site, pages, meta, jsonld, welcome] = await Promise.all(
    ['lib/seo/llms.ts', 'lib/seo/site.ts', 'lib/seo/pages.ts', 'lib/seo/meta.ts', 'lib/seo/jsonld.ts',
      'lib/emails/templates/welcome.ts'].map((r) => import(GRAPH.url(r))),
  );
  return withEnv(flag ? { CHORDS_CLAIMS: undefined } : OFF_ENV, () => {
    const email = welcome.renderWelcome({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 50 });
    return {
      '/llms.txt': llms.llmsText(),
      'siteDescription (app/layout.tsx default)': site.siteDescription(),
      'entityOneLiner': site.entityOneLiner(),
      'ogImage + ogAlt': `${site.ogImage()} ${site.ogAlt()}`,
      'every registry page description': pages.PUBLIC_PAGES.map((p) => p.description).join('\n'),
      'every registry page metadata': JSON.stringify(pages.PUBLIC_PAGES.map((p) => meta.pageMetadata(p))),
      'JSON-LD': JSON.stringify(jsonld.homeGraph()),
      'welcome email (subject + text)': `${email.subject}\n${email.text}`,
      'welcome email (html)': email.html,
    };
  });
}
const SURF_ON = await surfaces(true);
const SURF_OFF = await surfaces(false);

test('C-12: llms.txt, welcome email, default description, OG image/alt, JSON-LD — no chord claim with the switch OFF', () => {
  for (const k of ['/llms.txt', 'siteDescription (app/layout.tsx default)', 'ogImage + ogAlt', 'welcome email (subject + text)', 'JSON-LD']) {
    assert.match(SURF_ON[k], /chord/i, `sanity: ${k} talks about chords with the switch on`);
  }
  for (const [k, v] of Object.entries(SURF_OFF)) {
    assert.deepEqual(v.match(/.{0,50}chord.{0,50}/gi) ?? [], [], `${k} still claims chords`);
  }
  assert.doesNotMatch(SURF_OFF['every registry page metadata'], /og-image-v4/, 'a page still shares the image that draws chord names');
  assert.match(SURF_OFF['/llms.txt'], /each has a fader, mute and solo\. Tempo and pitch change are not available yet\./);
  assert.match(SURF_OFF['welcome email (subject + text)'], /Add a song and it opens in the player: six stems on faders, to play along to\./);
});

// ── 5. C-13: the welcome email no longer says paid plans are upload-only ──────────────────
test('C-13: the welcome email does not say Pro and Studio are upload-only, with the switch either way', () => {
  for (const s of [SURF_ON, SURF_OFF]) {
    for (const k of ['welcome email (subject + text)', 'welcome email (html)']) {
      assert.doesNotMatch(s[k], /files? you upload|upload(?:ed)? (?:audio )?files? only|only (?:work|works) with/i, k);
    }
  }
  assert.match(SURF_ON['welcome email (subject + text)'], /Add a song and it opens in the player: six stems on faders, with a chord track to play along to\./);
});

// ── 6. C-14: no unsupported processing-time figure ───────────────────────────────────────
test('C-14: no "about 1–3 minutes" (or any measured-looking duration) on /help, the home page or the tool', async () => {
  const home = await renderPage('app/(landing)/page.tsx');
  for (const [where, t] of [['/help', ON.help.textSpaced], ['/help off', OFF.help.textSpaced], ['home', home.textSpaced]]) {
    assert.doesNotMatch(t, /1\s*[–-]\s*3\s*minutes|0:51|3:07|9 October 2026|took about/i, where);
    // A processing time stated as a number of minutes or seconds is a measurement claim; only
    // the track cap ("the first N minutes") may carry a minute figure.
    const durations = [...t.matchAll(/\b(\d+(?:[–-]\d+)?)\s*(?:minutes?|mins?|seconds?|s)\b/g)].map((m) => m[0]);
    for (const d of durations) assert.match(d, new RegExp(`^${Math.floor(MAX_TRACK_SEC / 60)}\\s*minutes$`), `${where}: "${d}"`);
  }
  assert.match(ON.help.textSpaced, /How long does it take\? Usually a few minutes\. It depends on how long the song is and how busy the queue is\./);
});

// ── 7. C-17: /terms does not call paid plans optional ─────────────────────────────────────
test('C-17: /terms states the Free cap and that more needs a plan or credits', () => {
  for (const r of [ON.terms, OFF.terms]) {
    assert.doesNotMatch(r.textSpaced, /not required|Free to use at the moment/i);
    assert.match(r.textSpaced, /The Free plan costs nothing and covers \d+ songs a month on your account\. For more than that you need a paid plan \(Pro or Studio\), or credits for uploaded files \(credits do not add song links\)\./);
    assert.match(r.html, /<a href="\/pricing">pricing page<\/a>/);
    // Review SF-3: credits never extend link jobs, so the page must not offer them as a remedy for links.
    assert.doesNotMatch(r.textSpaced, /\bor credits[;.]/);
  }
});

test('SF-3: the "credits for uploaded files" claim matches the code: link jobs never spend a credit', () => {
  // The code, not a comment (comments stripped): the route's only credit spend is in the
  // upload branch, before the signed-in link hand-off, and the signed-in link path
  // (lib/jobs/create-link-job.ts, Phase B B0) has no credit consumer at all.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const route = strip(readFileSync(join(SRC, 'app/api/jobs/route.ts'), 'utf8'));
  const spends = [...route.matchAll(/consumeCreditInTx\(/g)].map((m) => m.index);
  assert.equal(spends.length, 1, 'one credit spend in the jobs route');
  const upload = route.indexOf('if (bodyObj.uploadKey) {');
  const link = route.indexOf('const r = await createAuthedLinkJob(');
  assert.ok(upload > 0 && link > upload && spends[0] > upload && spends[0] < link, 'the credit spend sits in the upload branch');
  const lib = strip(readFileSync(join(SRC, 'lib/jobs/create-link-job.ts'), 'utf8'));
  assert.doesNotMatch(lib, /consumeCredit/, 'the signed-in link path never spends a credit');
  // The DB is the authority: check_credit_decrement (013) refuses a credit for any non-upload job,
  // and no later migration redefines it.
  const dir = join(REPO, 'apps/worker/migrations');
  const defs = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .filter((f) => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[^(]*check_credit_decrement/i.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(defs, ['013_v3_commercial.sql'], 'check_credit_decrement is redefined: re-check "credits for uploaded files"');
  assert.match(readFileSync(join(dir, '013_v3_commercial.sql'), 'utf8'), /IF _input_kind != 'upload' THEN\s*RAISE EXCEPTION 'credit_consumption rejected/);
});

test('SF-4: /terms keeps its BILLING_ENFORCED switch-on checklist next to the Free figure', () => {
  const src = readFileSync(join(SRC, 'app/(landing)/terms/page.tsx'), 'utf8');
  const i = src.indexOf('const FREE_MONTHLY_SONGS');
  assert.ok(i > 0);
  assert.match(src.slice(Math.max(0, i - 2000), i), /BILLING_ENFORCED SWITCH-ON CHECKLIST[\s\S]*reword the Free sentence/);
});

test('nit: each legal page shows the same day as its registry lastModified', async () => {
  const { PUBLIC_PAGES } = await import('../src/lib/seo/pages.ts');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (const [path, r] of [['/terms', ON.terms], ['/privacy', ON.privacy]]) {
    const shown = r.textSpaced.match(/Last updated (\d{1,2}) (\w+) (\d{4})/);
    assert.ok(shown, `${path} shows a date`);
    const iso = `${shown[3]}-${String(MONTHS.indexOf(shown[2]) + 1).padStart(2, '0')}-${shown[1].padStart(2, '0')}`;
    assert.equal(iso, PUBLIC_PAGES.find((p) => p.path === path).lastModified, `${path}: "Last updated" and lastModified disagree`);
  }
});

// ── 8. numeric claims against their source of truth ──────────────────────────────────────
const MIG_034 = readFileSync(join(REPO, 'apps/worker/migrations/034_v3_pricing_model_truth.sql'), 'utf8');
const freeQuota034 = () => {
  const m = MIG_034.match(/\(\s*'free'\s*,\s*'Free'\s*,\s*(\d+)\s*,\s*(\d+)\s*,/);
  assert.ok(m, 'migration 034 seeds the free plan row');
  return { price: Number(m[1]), quota: Number(m[2]) };
};

test('numeric claims: the Free monthly songs on /terms equal plans.monthly_job_quota for free (migration 034)', () => {
  // No later migration may re-seed the free quota without this test moving with it.
  const later = readdirSync(join(REPO, 'apps/worker/migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) > 34)
    .filter((f) => /monthly_job_quota/.test(readFileSync(join(REPO, 'apps/worker/migrations', f), 'utf8')));
  assert.deepEqual(later, [], 'a later migration changes monthly_job_quota: point FREE_MONTHLY_SONGS and this test at it');
  const { quota, price } = freeQuota034();
  assert.equal(price, 0, '"The Free plan costs nothing" needs price_cad_cents 0');
  const said = [...ON.terms.textSpaced.matchAll(/(\d+)\s+songs? a month/g)].map((m) => Number(m[1]));
  assert.deepEqual(said, [quota]);
});

test('numeric claims: every hour and day figure on /help, /terms, /privacy, llms.txt and the welcome email is the retention config', () => {
  // Source of truth: lib/retention.ts, which the worker's cleanup.py mirrors (test_paid_retention.py).
  assert.match(JOB_RETAINED_UNTIL_SQL, new RegExp(`\\+ interval '${PAID_RETENTION_GRACE_DAYS} days'`), 'paid grace in the SQL');
  const pastDue = Number(JOB_RETAINED_UNTIL_SQL.match(/past_due' THEN s\.current_period_start \+ interval '(\d+) days'/)?.[1]);
  assert.ok(Number.isFinite(pastDue), 'past_due grace read from the SQL');
  const texts = {
    '/help': ON.help.textSpaced, '/terms': ON.terms.textSpaced, '/privacy': ON.privacy.textSpaced,
    '/llms.txt': SURF_ON['/llms.txt'], welcome: SURF_ON['welcome email (subject + text)'].replace(/\u00a0/g, ' '),
  };
  let hours = 0; let days = 0;
  for (const [where, t] of Object.entries(texts)) {
    for (const m of t.matchAll(/(\d+)\s*hours?\b/g)) { hours++; assert.equal(Number(m[1]), RETENTION_HOURS, `${where}: "${m[0]}"`); }
    for (const m of t.matchAll(/(\d+)\s*days?\b/g)) {
      days++;
      // "N days while a failed renewal …" is the past_due grace; every other day figure is the library grace.
      const ctx = t.slice(m.index, m.index + m[0].length + 40);
      const want = /^\d+\s*days? while a failed renewal/.test(ctx) ? pastDue : PAID_RETENTION_GRACE_DAYS;
      assert.equal(Number(m[1]), want, `${where}: "${ctx}"`);
    }
  }
  assert.ok(hours >= 5 && days >= 4, `expected the retention figures to be present (hours ${hours}, days ${days})`);
  // The welcome email's track cap is the player's cap.
  assert.match(texts.welcome, new RegExp(`Songs longer than ${Math.floor(MAX_TRACK_SEC / 60)} minutes use the first ${Math.floor(MAX_TRACK_SEC / 60)} minutes`));
});

// ── 9. the source scan ─────────────────────────────────────────────────────────────────────
// A file under src/ that mentions "chord" anywhere (comments included) must EITHER import and read
// chordsLineShown() from the one switch (or, for a CLIENT component, take it as the `chordsShown`
// prop from the server page that renders it: PROP_SWITCHED below), OR be listed in ALLOW below — by exact path, no folder
// prefixes — with the EXACT number of "chord" mentions it carries in COPY-CAPABLE text: string
// literals, template text, JSX text and JSX attribute strings (title, aria-label, data-*…), as the
// TypeScript parser sees them. Comments and identifiers (chordStatus, ChordOverlay) are not copy
// and are not counted. Module specifiers are not counted.
//
// WHY PINNED COUNTS (QA C-12 review MF-1, 2026-11-18). The first version exempted whole files and
// whole folders. A reviewer then put a chord promise in an allow-listed file's title attribute
// (JobView), appended one to an allow-listed disclosure page (account/delete), and created a new
// file under an allowed folder (components/play/Upsell.tsx). All three passed. With exact counts,
// any NEW chord text in an allowed file changes its count and fails here, and a new file is never
// allowed implicitly. A count going DOWN also fails, so the list cannot rot into headroom.
// When this fails on a legitimate change: read the new mention. If it promises a chord track to a
// NEW song, gate it on the switch; if it renders a job's own chord data or a disclosure, update the
// count and say why in the reason.
const ALLOW = {
  // the player and its chord track: render THE JOB'S OWN chord data, or "No chords for this song."
  'src/components/ChordOverlay.tsx': [27, 'player chord track: testids, aria-labels and pickers for the job\'s own chords'],
  'src/components/ChordOverlay.helpers.ts': [25, 'player chord track helpers: labels for the job\'s own chord runs ("No chord", "Unknown chord", kind === \'chord\')'],
  'src/components/ChordPhone.helpers.ts': [3, 'player chord track helpers (phone)'],
  'src/components/tapTarget.ts': [0, 'comments only (the shared tap floor, QA-73)'],
  'src/components/play/PlayerScreen.tsx': [12, 'player: NO_CHORDS_LINE ("No chords for this song.") and no-chords testids; the ⋯ "Chords: Simple / Detailed" view toggle (Phase A, D6) over the job\'s own chords'],
  'src/components/play/TransposeMenuItem.tsx': [1, 'the ⋯ "Capo / transpose" stepper (Phase C, C4): a display shift of the job\'s own chords, no promise about new songs'],
  'src/lib/play/transpose.ts': [0, 'comments only (the Capo / transpose display layer, Phase C C4)'],
  'src/lib/play/simplify-chords.ts': [0, 'comments only (the Simple chord display layer, Phase A D6)'],
  'src/lib/library.ts': [1, 'a DELETION disclosure, not a promise: the library note says the chord file goes at 24 hours with the audio (Phase B, PB-1)'],
  'src/lib/play/chord-mode.ts': [1, 'the stored Simple / Detailed chord-view choice (Phase A, D6): a storage key, no promise'],
  'src/components/play/MixSheet.tsx': [0, 'comments only'],
  'src/components/play/Player.tsx': [0, 'comments only'],
  'src/components/play/Presets.tsx': [0, 'comments only'],
  'src/components/play/Transport.tsx': [0, 'comments only'],
  'src/lib/play/background-audio.ts': [0, 'comments only'],
  'src/lib/read-rate-limit.ts': [0, 'comments only (names the /play-chords route it limits)'],
  'src/lib/play/engine.ts': [0, 'comments only'],
  'src/lib/play/notation.ts': [0, 'comments and identifiers only'],
  'src/lib/play/ogg-opus.ts': [0, 'comments only'],
  'src/lib/play/sections.ts': [0, 'comments only'],
  'src/lib/play/types.ts': [0, 'comments and identifiers only'],
  // the in-browser chord engine: code; its strings are errors, keys and log lines
  'src/chord/alphabet.ts': [1, 'engine: one internal string'],
  'src/chord/chordnet-session.ts': [16, 'engine: model paths, errors, log lines'],
  'src/chord/cqt-frontend.ts': [0, 'comments only'],
  'src/chord/edit-collector.ts': [7, 'engine: storage keys and API path for chord edits'],
  'src/chord/harte.ts': [0, 'comments only'],
  'src/chord/play-chords-loader.ts': [7, 'engine: play-chords API path and errors'],
  'src/chord/sha256.ts': [0, 'comments only'],
  'src/chord/smoother.ts': [1, 'engine: one internal string'],
  'src/chord/tab-capture.ts': [4, 'engine: errors and log lines'],
  'src/chord/transition.ts': [0, 'comments only'],
  'src/chord/viterbi.ts': [0, 'comments only'],
  // API routes: JSON for the player, no marketing copy
  'src/app/api/chord-edits/route.ts': [31, 'API: chord_edits SQL, columns and error messages'],
  'src/app/api/jobs/[id]/play-chords/route.ts': [1, 'API: the play.chords.json key'],
  'src/app/api/users/me/route.ts': [2, 'API: erases chord edits on account delete'],
  'src/app/api/jobs/[id]/download/route.ts': [0, 'comments only'],
  'src/app/api/jobs/[id]/route.ts': [0, 'comments only'],
  'src/app/api/jobs/[id]/stems/route.ts': [0, 'comments only'],
  // disclosures and plumbing
  'src/app/account/delete/page.tsx': [1, 'DISCLOSURE: "Any chord corrections you saved" among what deletion removes'],
  'src/components/DeleteAccountForm.tsx': [0, 'imports the chord edit collector to clear it: code'],
  'src/app/account/layout.tsx': [0, 'comment only'],
  'src/app/jobs/[id]/JobView.tsx': [0, 'comments only (the player owns the chord track)'],
  'src/app/jobs/[id]/page.tsx': [0, 'comment only (names the play-chords route)'],
  'src/lib/r2.ts': [1, 'storage: the play.chords.json key'],
  'src/lib/job-access.ts': [3, "the JobAction name 'edit_chords' (type, list and switch case): code, never rendered"],
  'src/lib/admission.ts': [0, 'comments only (Slice 2a: names the play-chords route)'],
  'src/lib/demo-rate.ts': [0, 'comments only (Slice 2a: names the play-chords route)'],
  'src/lib/job-poll.ts': [0, 'comments only'],
  'src/lib/stem-keys.ts': [0, 'comments only'],
  'src/lib/stem-urls.ts': [0, 'comments only'],
  'src/lib/upload.ts': [0, 'comments only'],
  'src/middleware.ts': [0, 'comments only'],
  // A4 (2026-11-21): comments naming the DB-17 runtime switch, on files that build metadata or a
  // route body through the switched modules
  'src/app/(landing)/help/page.tsx': [0, 'comment only (why the page is dynamic: the runtime chord switch)'],
  'src/app/layout.tsx': [0, 'comment only (generateMetadata reads the switched default description)'],
  'src/app/llms.txt/route.ts': [0, 'comment only (why the route is dynamic)'],
  'src/app/loops/layout.tsx': [0, 'comment only (generateMetadata: the shared OG image is switched)'],
  'src/app/pricing/layout.tsx': [0, 'comment only (generateMetadata: the shared OG image is switched)'],
  'src/components/landing/legal.ts': [0, 'comments only (the legal dates follow CHORDS_CLAIMS_CHANGED_ON)'],
  'src/lib/seo/meta.ts': [0, 'comment only (reads the switched OG image per call)'],
  // outside src/ (QA follow-up S-1: the scan covers all of apps/web except node_modules, .next, test)
  'package.json': [3, 'the test:chord script name and its paths: tooling, never rendered'],
  'e2e/chord-overlay-safari.spec.ts': [3, 'a manual Playwright QA stub for the player\'s chord overlay: not shipped'],
};
// Files that READ the switch are covered by the OFF renders above — but only for text they render.
// An unrendered export (a new const nobody imports yet) would slip past the renders, so these are
// pinned at their exact copy count too (review A3). Every chord literal in them is either inside a
// switch branch that an OFF render proves gone, or a /privacy or /terms DISCLOSURE.
const SWITCHED = {
  'src/app/(landing)/page.tsx': 2, // A4: the hero lead and the OG description, both ON branches
  'src/app/loops/page.tsx': 0, // reads the switch and passes it to LoopsView
  'src/app/(landing)/privacy/page.tsx': 8,
  'src/app/(landing)/terms/page.tsx': 4,
  'src/components/landing/faq.tsx': 5,
  'src/lib/emails/templates/welcome.ts': 1,
  'src/lib/seo/jsonld.ts': 1,
  'src/lib/seo/llms.ts': 1,
  'src/lib/seo/pages.ts': 2,
  'src/lib/seo/site.ts': 3,
};
const IMPORT_RE = /import \{[^}]*\bchordsLineShown\b[^}]*\} from '(?:@\/lib\/chords-claim|\.\.\/chords-claim\.ts|\.\/chords-claim)'/;
// Client components cannot read the server environment, so they take the switch as a prop. Each
// is pinned at its exact copy count, and each has an OFF render elsewhere: HomeDemo in
// test/p7-copy.test.mjs (the home page with CHORDS_CLAIMS=off), LoopsView in test/loops-page.test.mjs.
const PROP_SWITCHED = {
  'src/components/landing/HomeDemo.tsx': 1, // the demo note: "chords in time", ON branch only
  'src/app/loops/LoopsView.tsx': 1, // "The stems and chords are still in the player.", ON branch only
  'src/components/landing/what-you-get.ts': 2, // the Chords proof point; whatYouGet(chordsShown) is called by the home page
};
const PROP_RE = /\bchordsShown\b/g;

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs|js|md|txt|json)$/.test(n) ? [p] : [];
});

// QA follow-up S-1: the scan walks ALL of apps/web, not only src/, so copy kept in a JSON, Markdown
// or content file anywhere in the app (and imported into a page) is counted too. Only the build
// output, the dependencies and the test tree are skipped. CSS is not walked: generated `content:`
// text is named residue in the PR (as in test/helpers/render-landing-page.mjs).
const WEB_SKIP = new Set(['node_modules', '.next', 'test']);
const walkWeb = (d, top = true) => readdirSync(d).flatMap((n) => {
  if (top && WEB_SKIP.has(n)) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walkWeb(p, false)
    : /\.(tsx?|mjs|cjs|js|jsx|mdx?|txt|json|ya?ml|html?|svg|webmanifest)$/.test(n) ? [p] : [];
});

/** "chord" mentions in copy-capable text, by the TypeScript parser: string literals, template
 *  text, JSX text and JSX attribute strings. Not comments, identifiers or module specifiers.
 *  A non-code file (md, txt, json) counts every mention. */
function copyChordMentions(path, text = readFileSync(path, 'utf8')) {
  if (!/\.(tsx?|mjs|cjs|jsx?)$/.test(path)) return (text.match(/chord/gi) ?? []).length;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // module specifiers
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    let t = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) t = node.text;
    else if (ts.isJsxText(node)) t = node.getText(sf);
    if (t) n += (t.match(/chord/gi) ?? []).length;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

test('source scan: the copy counter sees literals, JSX text and attributes, and ignores comments and identifiers', () => {
  const f = 'x.tsx';
  assert.equal(copyChordMentions(f, '// chord chord\nconst chordRun = 1; /* chords */'), 0);
  assert.equal(copyChordMentions(f, "import { a } from '../chord/x';\nconst m = await import('../chord/y');"), 0);
  assert.equal(copyChordMentions(f, "const s = 'a chord'; const t = `x ${1} chords`;"), 2);
  assert.equal(copyChordMentions(f, 'const e = <div title="Every song gets a chord track.">Chords in time</div>;'), 2);
  assert.equal(copyChordMentions(f, 'const e = <p data-x={`chord-${1}`}>{"chord"}</p>;'), 2);
  assert.equal(copyChordMentions('x.md', '# chords'), 1);
});

/** Offending files under `root` (an apps/web-shaped tree), and which ALLOW/SWITCHED keys were seen. */
function scan(root) {
  const offenders = [];
  const seen = new Set();
  for (const abs of walkWeb(root)) {
    const rel = relative(root, abs).split('\\').join('/');
    if (rel === 'src/lib/chords-claim.ts') continue;
    if (/(^|\/)__tests__\/|\.test\.mjs$/.test(rel)) continue; // tests, not shipped
    const t = readFileSync(abs, 'utf8');
    if (!/chord/i.test(t)) continue;
    if (PROP_SWITCHED[rel] !== undefined) {
      // A client component: it must declare the prop AND read it.
      assert.ok((t.match(PROP_RE) ?? []).length >= 2, `${rel} is listed as taking chordsShown but never reads it`);
      assert.doesNotMatch(t, /from '@\/lib\/chords-claim'/, `${rel} is a client component: it cannot read the server switch itself`);
      seen.add(rel);
      const k = copyChordMentions(abs, t);
      if (k !== PROP_SWITCHED[rel]) offenders.push(`${rel}: takes chordsShown, ${k} chord mention(s) in copy-capable text, pinned at ${PROP_SWITCHED[rel]}`);
      continue;
    }
    if (IMPORT_RE.test(t)) {
      // Importing it is not enough: it must be called somewhere past the import.
      assert.ok((t.match(/\bchordsLineShown\(/g) ?? []).length >= 1, `${rel} imports the switch but never reads it`);
      assert.doesNotMatch(t, /process\.env\.CHORDS_CLAIMS|CHORDS_CLAIMS_ENV\]/, `${rel} reads the variable itself instead of the one switch`);
      assert.ok(!ALLOW[rel], `${rel} imports the switch: drop it from ALLOW`);
      seen.add(rel);
      const k = copyChordMentions(abs, t);
      if (k !== SWITCHED[rel]) offenders.push(`${rel}: reads the switch, ${k} chord mention(s) in copy-capable text, pinned at ${SWITCHED[rel]} (gate any new one, prove it in an OFF render, then update SWITCHED)`);
      continue;
    }
    const n = copyChordMentions(abs, t);
    if (!ALLOW[rel]) { offenders.push(`${rel}: not allow-listed (${n} chord mention(s) in copy-capable text)`); continue; }
    seen.add(rel);
    if (n !== ALLOW[rel][0]) offenders.push(`${rel}: ${n} chord mention(s) in copy-capable text, allow-listed at ${ALLOW[rel][0]} (${ALLOW[rel][1]})`);
  }
  return { offenders, seen };
}

test('source scan: every file that mentions "chord" reads the switch, or is allow-listed at its exact copy count', () => {
  const { offenders, seen } = scan(WEB);
  assert.deepEqual(offenders, [], 'chord text outside the DB-17 switch: gate it on chordsLineShown(), or (if it is not a promise to a new song) update ALLOW with a reason');
  // A stale entry is a hole waiting to be reused.
  assert.deepEqual(Object.keys(ALLOW).filter((k) => !seen.has(k)), [], 'ALLOW names a file that no longer mentions chords');
  assert.deepEqual(Object.keys(SWITCHED).filter((k) => !seen.has(k)), [], 'SWITCHED names a file that no longer reads the switch');
  assert.deepEqual(Object.keys(PROP_SWITCHED).filter((k) => !seen.has(k)), [], 'PROP_SWITCHED names a file that no longer takes the prop');
});

// The reviewer's S-1 case (rev299-tools/mut2.py E3a): a JSON file OUTSIDE src/ — apps/web/content/
// promo.json — imported into JobView, carrying "Every new song gets a chord track." Built in a temp
// tree shaped like apps/web, so the real tree is never written to. Also proves the skipped dirs.
test('source scan (S-1): a content file outside src/ is counted; node_modules, .next and test are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'chords-scan-'));
  try {
    const put = (rel, txt) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), txt); };
    put('content/promo.json', '{"promo":"Every new song gets a chord track."}\n');
    put('src/app/jobs/[id]/JobView.tsx', "import promo from '../../../../content/promo.json';\nexport const T = () => <div title={promo.promo} />;\n");
    for (const d of ['node_modules/x/promo.json', '.next/server/promo.json', 'test/fixtures/promo.json']) put(d, '{"p":"chord"}');
    const { offenders } = scan(root);
    assert.deepEqual(offenders, ['content/promo.json: not allow-listed (1 chord mention(s) in copy-capable text)']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source scan: public/ text assets carry no chord claim', () => {
  // Images are covered by OG_IMAGE (above); this is for robots/llms-style text files.
  const hits = walk(join(WEB, 'public')).filter((p) => /\.(txt|md|json|webmanifest|html)$/.test(p) && !/cqt-plan/.test(p))
    .filter((p) => /chord/i.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits.map((p) => relative(WEB, p)), []);
});

// ── PR #332 round 2: "the date above shows the latest version" survives the flip ──────────────
// The switch changes /terms and /privacy text without a code change, so the shown "Last updated"
// day is the LATER of the page's own day and CHORDS_CLAIMS_CHANGED_ON (YYYY-MM-DD, validated).
test('CHORDS_CLAIMS_CHANGED_ON: the flip day moves "Last updated" (and lastModified) on /terms and /privacy', async () => {
  const { parseIsoDay, legalUpdated } = await import('../src/lib/chords-claim.ts');
  for (const bad of ['', '2026-13-01', '2026-02-30', '26-12-05', '2026-12-5', 'tomorrow', '2026-12-05T00:00']) assert.equal(parseIsoDay(bad), null, bad);
  assert.equal(parseIsoDay(' 2026-12-05 '), '2026-12-05');
  await withEnv({ CHORDS_CLAIMS_CHANGED_ON: '2026-12-05' }, () => assert.equal(legalUpdated('2026-11-21'), '2026-12-05'));
  await withEnv({ CHORDS_CLAIMS_CHANGED_ON: '2026-11-01' }, () => assert.equal(legalUpdated('2026-11-21'), '2026-11-21', 'an earlier flip day never moves a date back'));
  await withEnv({ CHORDS_CLAIMS_CHANGED_ON: 'garbage' }, () => assert.equal(legalUpdated('2026-11-21'), '2026-11-21'));
  for (const [file, path] of [[TERMS, '/terms'], [PRIVACY, '/privacy']]) {
    const r = await renderPage(file, { env: { CHORDS_CLAIMS: 'off', CHORDS_CLAIMS_CHANGED_ON: '2026-12-05' } });
    assert.match(r.textSpaced, /Last updated 5 December 2026/, path);
    const lm = await withEnv({ CHORDS_CLAIMS_CHANGED_ON: '2026-12-05' }, async () => {
      const { PUBLIC_PAGES } = await import('../src/lib/seo/pages.ts');
      return PUBLIC_PAGES.find((p) => p.path === path).lastModified;
    });
    assert.equal(lm, '2026-12-05', `${path}: lastModified follows the flip day`);
  }
  // Unset: the pages' own days.
  assert.match(ON.terms.textSpaced, /Last updated 22 November 2026/);
  assert.match(ON.privacy.textSpaced, /Last updated 22 November 2026/);
});
