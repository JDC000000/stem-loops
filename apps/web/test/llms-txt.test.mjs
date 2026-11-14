// SEO-07: /llms.txt is plain text built from the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/llms.txt/route.ts';
import { ENTITY_LIMITS, ENTITY_ONE_LINER } from '../src/lib/seo/site.ts';
import { PUBLIC_PAGES } from '../src/lib/seo/pages.ts';
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
  assert.equal(body.split('\n').filter((l) => l.startsWith('- [')).length, listed);
});

test('ENTITY_LIMITS states the five brand limits, with the player cap as its only minute figure', () => {
  const cap = Math.floor(MAX_TRACK_SEC / 60);
  assert.ok(ENTITY_LIMITS.includes(`uses the first ${cap} minutes of any song`));
  assert.doesNotMatch(ENTITY_LIMITS, /\bup to\s+\d+\s*minutes?\b/i, '#270: longer songs are trimmed, not refused');
  assert.deepEqual([...ENTITY_LIMITS.matchAll(/(\d+)\s*minutes?/g)].map((m) => Number(m[1])), [cap]);
  assert.match(ENTITY_LIMITS, /Chrome on the desktop/);
  assert.match(ENTITY_LIMITS, /after 24 hours/);
  assert.match(ENTITY_LIMITS, /account to open the player/);
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
