// robots.txt policy gate (SL15, Jon 2026-10-31): the two AI *search* bots may crawl the public
// pages; every AI training/fetch crawler stays blocked site-wide. Fails if a training crawler is
// allowed or a search bot is blocked / allowed onto /api or /jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import robots from '../src/app/robots.ts';

const rules = robots().rules;
const forBot = (ua) => rules.filter((r) => [].concat(r.userAgent).includes(ua));
const dis = (r) => [].concat(r.disallow ?? []);

const SEARCH = ['OAI-SearchBot', 'PerplexityBot'];
const BLOCKED = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Google-Extended',
  'Bytespider', 'Amazonbot', 'Applebot-Extended', 'meta-externalagent'];

test('wildcard rule unchanged: allow /', () => {
  const star = forBot('*');
  assert.equal(star.length, 1);
  assert.equal(star[0].allow, '/');
  assert.deepEqual(dis(star[0]), []);
});

for (const ua of SEARCH) {
  test(`${ua}: allowed on / but not on /api/ or /jobs/`, () => {
    const r = forBot(ua);
    assert.equal(r.length, 1, 'exactly one rule');
    assert.equal(r[0].allow, '/');
    assert.ok(!dis(r[0]).includes('/'), 'must not be blocked site-wide');
    assert.deepEqual(dis(r[0]).sort(), ['/api/', '/jobs/']);
  });
}

for (const ua of BLOCKED) {
  test(`${ua}: blocked site-wide`, () => {
    const r = forBot(ua);
    assert.equal(r.length, 1, 'exactly one rule');
    assert.deepEqual(dis(r[0]), ['/']);
    assert.ok(!r[0].allow, 'must not have an allow');
  });
}
