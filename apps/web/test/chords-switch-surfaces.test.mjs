// QA C-12..C-17 (2026-11-18). DB-17: new songs may stop getting chords after 2026-12-05, and the
// ONE switch for that is CHORDS_LINE_SHOWN in src/lib/chords-claim.ts. test/p7-copy.test.mjs
// proves the home page obeys it. This file proves EVERY OTHER public surface does:
//
//   1. /help, /terms and /privacy are RENDERED (the repo's rule: test/helpers/render-landing-page.mjs)
//      with the switch patched to false at its one definition, and searched in DOM text (both
//      normalisations), accessible-name attributes, the markup and the page metadata.
//   2. /llms.txt, the welcome email, the site-wide default description, the shared Open Graph
//      image + alt, and the JSON-LD are built from a module graph whose chords-claim.ts is the
//      REAL file with `true` flipped to `false` — the same edit the operator will make.
//   3. /privacy keeps its DISCLOSURES with the switch off (Klangio as a processor; the chord data
//      that already exists). Gating the promise must not silently drop the disclosure.
//   4. A source scan: any file under src/ that mentions "chord" must either import the switch or
//      be on ALLOW below, with a reason. A new marketing surface that mentions chords and forgets
//      the switch fails here, before 12-05 makes it false.
//   5. Numeric claims on these surfaces (retention hours/days, the Free monthly songs, the track
//      cap) are checked against the config or migration they come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './helpers/render-landing-page.mjs';
import { buildModuleGraph } from './helpers/module-graph.mjs';
import { RETENTION_HOURS, PAID_RETENTION_GRACE_DAYS, JOB_RETAINED_UNTIL_SQL } from '../src/lib/retention.ts';
import { MAX_TRACK_SEC } from '../src/lib/play/types.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const REPO = join(WEB, '..', '..');
const SWITCH_REL = join('lib', 'chords-claim.ts');
const SWITCH_SRC = readFileSync(join(SRC, SWITCH_REL), 'utf8');
const ON_LINE = 'export const CHORDS_LINE_SHOWN = true;';
const OFF_LINE = 'export const CHORDS_LINE_SHOWN = false;';

test('sanity: the switch is ON today, defined once, so every OFF render below is a real flip', () => {
  assert.equal(SWITCH_SRC.split(ON_LINE).length - 1, 1, 'the switch must be ON today and defined exactly once');
});

const flipOff = (rel, src) => (rel === SWITCH_REL ? src.replace(ON_LINE, OFF_LINE) : src);
const page = (p) => renderPage(p);
const pageOff = (p) => renderPage(p, { patch: flipOff });

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
const graphFor = (flag) => buildModuleGraph({
  name: `chords-surfaces-${flag ? 'on' : 'off'}`,
  entries: ['lib/seo/llms.ts', 'lib/seo/site.ts', 'lib/seo/pages.ts', 'lib/seo/meta.ts', 'lib/seo/jsonld.ts',
    'lib/emails/templates/welcome.ts'],
  // The REAL switch file, flipped the way the operator will flip it. ON is the file untouched.
  overrides: flag ? {} : { [SWITCH_REL]: SWITCH_SRC.replace(ON_LINE, OFF_LINE) },
});
async function surfaces(flag) {
  const g = graphFor(flag);
  const [llms, site, pages, meta, jsonld, welcome] = await Promise.all(
    ['lib/seo/llms.ts', 'lib/seo/site.ts', 'lib/seo/pages.ts', 'lib/seo/meta.ts', 'lib/seo/jsonld.ts',
      'lib/emails/templates/welcome.ts'].map((r) => import(g.url(r))),
  );
  const email = welcome.renderWelcome({ plan_code: 'pro', period_end: '2027-01-15T00:00:00Z', monthly_job_quota: 50 });
  return {
    '/llms.txt': llms.llmsText(),
    'SITE_DESCRIPTION (app/layout.tsx default)': site.SITE_DESCRIPTION,
    'ENTITY_ONE_LINER': site.ENTITY_ONE_LINER,
    'OG_IMAGE + OG_ALT': `${site.OG_IMAGE} ${site.OG_ALT}`,
    'every registry page description': pages.PUBLIC_PAGES.map((p) => p.description).join('\n'),
    'every registry page metadata': JSON.stringify(pages.PUBLIC_PAGES.map((p) => meta.pageMetadata(p))),
    'JSON-LD': JSON.stringify(jsonld.homeGraph()),
    'welcome email (subject + text)': `${email.subject}\n${email.text}`,
    'welcome email (html)': email.html,
  };
}
const SURF_ON = await surfaces(true);
const SURF_OFF = await surfaces(false);

test('C-12: llms.txt, welcome email, default description, OG image/alt, JSON-LD — no chord claim with the switch OFF', () => {
  for (const k of ['/llms.txt', 'SITE_DESCRIPTION (app/layout.tsx default)', 'OG_IMAGE + OG_ALT', 'welcome email (subject + text)', 'JSON-LD']) {
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
    assert.match(r.textSpaced, /The Free plan costs nothing and covers \d+ songs a month on your account\. For more than that you need a paid plan \(Pro or Studio\) or credits/);
    assert.match(r.html, /<a href="\/pricing">pricing page<\/a>/);
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
// A file under src/ that mentions "chord" (any case, comments included: a false RED is cheap)
// must either import CHORDS_LINE_SHOWN from the one switch, or be listed here with the reason
// it carries no PROMISE of a chord track to a new song.
const ALLOW_PREFIX = {
  'chord/': 'the in-browser chord engine and loaders: code, no copy',
  'app/api/': 'API routes: JSON for the player, no marketing copy',
  'lib/play/': 'player engine and notation: renders the chord data a job actually has',
  'components/play/': 'the player UI: shows the job\'s own chord track, or "No chords for this song."',
};
const ALLOW = {
  'components/ChordOverlay.tsx': 'player chord track: renders the job\'s own data',
  'components/ChordOverlay.helpers.ts': 'player chord track helpers',
  'components/ChordPhone.helpers.ts': 'player chord track helpers (phone)',
  'components/DeleteAccountForm.tsx': 'clears buffered chord EDITS on delete: code',
  'app/account/delete/page.tsx': 'DISCLOSURE: lists saved chord corrections among what deletion removes',
  'app/account/layout.tsx': 'comment only',
  'app/jobs/[id]/JobView.tsx': 'comment only (the player owns the chord track)',
  'app/jobs/[id]/page.tsx': 'comment only (names the play-chords route)',
  'lib/job-access.ts': 'access control for the play-chords route: code',
  'lib/job-poll.ts': 'polls the job, including its chord status: code',
  'lib/r2.ts': 'storage keys for play.chords.json: code',
  'lib/stem-keys.ts': 'storage keys: code',
  'lib/stem-urls.ts': 'signed URLs, including the chord file: code',
  'lib/upload.ts': 'upload pipeline comment: code',
  'middleware.ts': 'route matcher names the chord routes: code',
};
const IMPORT_RE = /import \{[^}]*\bCHORDS_LINE_SHOWN\b[^}]*\} from '(?:@\/lib\/chords-claim|\.\.\/chords-claim\.ts|\.\/chords-claim)'/;

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs|js|md|txt|json)$/.test(n) ? [p] : [];
});

test('source scan: every file that mentions "chord" reads the switch or is on the reasoned allow-list', () => {
  const offenders = [];
  const allowedSeen = new Set();
  for (const abs of walk(SRC)) {
    const rel = relative(SRC, abs).split('\\').join('/');
    if (rel === 'lib/chords-claim.ts') continue;
    if (/(^|\/)__tests__\/|\.test\.mjs$/.test(rel)) continue; // tests, not shipped
    const t = readFileSync(abs, 'utf8');
    if (!/chord/i.test(t)) continue;
    if (IMPORT_RE.test(t)) {
      // Importing it is not enough: it must be read somewhere past the import.
      assert.ok((t.match(/\bCHORDS_LINE_SHOWN\b/g) ?? []).length >= 2, `${rel} imports the switch but never reads it`);
      assert.doesNotMatch(t, /const CHORDS_LINE_SHOWN\s*=/, `${rel} defines its own switch`);
      continue;
    }
    if (ALLOW[rel]) { allowedSeen.add(rel); continue; }
    if (Object.keys(ALLOW_PREFIX).some((p) => rel.startsWith(p))) continue;
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these files mention chords without the DB-17 switch: import CHORDS_LINE_SHOWN, or add a reasoned ALLOW entry');
  // A stale allow-list entry is a hole waiting to be reused.
  assert.deepEqual(Object.keys(ALLOW).filter((k) => !allowedSeen.has(k)), [], 'ALLOW names a file that no longer mentions chords (or now imports the switch)');
});

test('source scan: public/ text assets carry no chord claim', () => {
  // Images are covered by OG_IMAGE (above); this is for robots/llms-style text files.
  const hits = walk(join(WEB, 'public')).filter((p) => /\.(txt|md|json|webmanifest|html)$/.test(p) && !/cqt-plan/.test(p))
    .filter((p) => /chord/i.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits.map((p) => relative(WEB, p)), []);
});
