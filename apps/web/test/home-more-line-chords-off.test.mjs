// #488 (#480 residue): the home page's "In the player's ⋯ menu" line with the DB-17 chords switch
// OFF. Capo / transpose moves chord NAMES only and shows only when the song has chords
// (components/play/TransposeMenuItem.tsx), so with CHORDS_CLAIMS=off the line must drop
// "or set a capo" and keep the Speed half. landing-copy.test.mjs pins the ON line; this file pins
// the OFF one, read from the RENDERED page (test/helpers/render-landing-page.mjs) so a line that is
// hidden, commented out or built elsewhere cannot satisfy it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './helpers/render-landing-page.mjs';

const HOME = 'app/(landing)/page.tsx';
const ON = await renderPage(HOME, { env: { CHORDS_CLAIMS: undefined } });
const OFF = await renderPage(HOME, { env: { CHORDS_CLAIMS: 'off' } });

const flatten = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const moreLine = (r) => {
  const all = [...r.html.matchAll(/<p class="wyg-more"[^>]*>([\s\S]*?)<\/p>/g)];
  assert.equal(all.length, 1, 'exactly one "In the player’s ⋯ menu" line is rendered');
  return flatten(all[0][1]);
};

const LEAD = 'In the player’s ⋯ menu:';
const SPEED = 'slow down to 90% or 75%, same pitch (Beta)';

test('sanity: the ON render offers the capo, so the OFF render below is a real flip', () => {
  assert.equal(moreLine(ON), `${LEAD} ${SPEED}, or set a capo.`);
});

test('#488: with CHORDS_CLAIMS=off the ⋯ line drops "or set a capo" and keeps the Speed half', () => {
  assert.equal(moreLine(OFF), `${LEAD} ${SPEED}.`);
  for (const [where, text] of [['text (spaced)', OFF.textSpaced], ['text (tight)', OFF.textTight],
    ['metadata (spaced)', OFF.metaSpaced], ['metadata (tight)', OFF.metaTight]]) {
    assert.doesNotMatch(text, /\bcapo\b|transpos/i, `${where} still offers a capo / transpose with the switch off`);
  }
});

test('#488: every falsy spelling of the switch drops the capo half (the page reads parseChordsClaims)', async () => {
  for (const v of ['OFF', ' false ', '0', 'no']) {
    const r = await renderPage(HOME, { env: { CHORDS_CLAIMS: v } });
    assert.equal(moreLine(r), `${LEAD} ${SPEED}.`, `CHORDS_CLAIMS=${JSON.stringify(v)}`);
  }
});
