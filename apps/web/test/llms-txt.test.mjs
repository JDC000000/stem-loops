// SEO-07: /llms.txt is plain text built from the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/llms.txt/route.ts';
import { ENTITY_LIMITS, ENTITY_ONE_LINER } from '../src/lib/seo/site.ts';
import { PUBLIC_PAGES } from '../src/lib/seo/pages.ts';
import { DEMO_SONGS, demoHref } from '../src/lib/demo-catalog.ts';
import { MAX_TRACK_SEC } from '../src/lib/play/types.ts';

test('llms.txt: text/plain, entity sentence, limits, one line per listed page', async () => {
  const res = GET();
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const body = await res.text();
  assert.ok(body.startsWith('# stem-loops\n'));
  assert.ok(body.includes(ENTITY_ONE_LINER));
  assert.ok(body.includes(ENTITY_LIMITS));
  assert.ok(body.includes('Tempo and pitch change are not available yet.'));
  const listed = PUBLIC_PAGES.filter((p) => p.published && p.llms).length;
  assert.equal(body.split('\n').filter((l) => l.startsWith('- [')).length, listed + DEMO_SONGS.length);
});

test('ENTITY_LIMITS states the five brand limits, with the player cap as its only minute figure', () => {
  const cap = Math.floor(MAX_TRACK_SEC / 60);
  assert.ok(ENTITY_LIMITS.includes(`uses the first ${cap} minutes of any song`));
  assert.doesNotMatch(ENTITY_LIMITS, /\bup to\s+\d+\s*minutes?\b/i, '#270: longer songs are trimmed, not refused');
  assert.deepEqual([...ENTITY_LIMITS.matchAll(/(\d+)\s*minutes?/g)].map((m) => Number(m[1])), [cap]);
  assert.match(ENTITY_LIMITS, /Chrome on a computer/);
  assert.match(ENTITY_LIMITS, /lighter audio on phones/);
  assert.match(ENTITY_LIMITS, /after 24 hours/);
  assert.match(ENTITY_LIMITS, /You need an account to open the player with your own songs/, 'D-SEO-7 wording');
  assert.match(ENTITY_LIMITS, /demo songs open without signing in/);
  assert.match(ENTITY_LIMITS, /rights to the audio/);
});

test('entity text keeps the brand truth rules: no platform, no downbeat or speed promise, chords are an estimate', async () => {
  const body = await GET().text();
  for (const [where, text] of [['ENTITY_ONE_LINER', ENTITY_ONE_LINER], ['ENTITY_LIMITS', ENTITY_LIMITS], ['llms.txt', body]]) {
    for (const re of [/youtube/i, /downbeat/i, /under\s+60\s+seconds/i, /no account needed/i, /\bup to\s+\d+\s*minutes?\b/i, /\brefused\b/i]) assert.doesNotMatch(text, re, `${where} matches ${re}`);
  }
  assert.ok(body.includes('The chord track is an estimate made from the audio, not a transcription.'));
  assert.ok(body.includes('The six stems are drums, bass, guitar, keys, vocals and other'), 'Story 2.1 stem order');
});

// QA-55: since #302 the demo songs play signed out, so an unqualified "you need an account to open
// the player" is false. llms.txt must say the demos are open and list each demo URL.
test('llms.txt: no unqualified account claim; lists every demo song URL from the catalog', async () => {
  const body = await GET().text();
  // Unqualified it is false since #302; D-SEO-7's qualified form ("... with your own songs") is the truth.
  assert.doesNotMatch(body, /need an account to open the player(?! with your own songs)/i);
  assert.ok(body.includes('/demo/'));
  assert.match(body, /without signing in/);
  for (const d of DEMO_SONGS) assert.ok(body.includes(`(https://stem-loops.com${demoHref(d.slug)})`), `${d.slug} missing`);
  assert.doesNotMatch(body, /llms-full\.txt/, 'llms-full.txt is not served (404); do not link it');
});

// QA-55 review B1: starting a job needs no account (POST /api/jobs accepts signed-out jobs; only
// /jobs/<id> redirects to /login). llms.txt must never say adding or starting a song needs one.
test('llms.txt: never claims an account is needed to add, start or upload a song', async () => {
  const body = await GET().text();
  for (const re of [
    /(add|adding|start|starting|upload|uploading|paste|pasting)[^.;]{0,40}\b(needs?|requires?)\b[^.;]{0,20}\baccount/i,
    /\b(need|needs|require|requires)\b[^.;]{0,20}\baccount\b[^.;]{0,10}\bto (add|start|upload|paste)\b/i,
  ]) assert.doesNotMatch(body, re);
  assert.match(body, /open the player with your own songs/);
});
