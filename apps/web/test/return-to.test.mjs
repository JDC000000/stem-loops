import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReturnTo } from '../src/lib/auth/return-to.ts';

test('accepts same-origin paths', () => {
  assert.equal(sanitizeReturnTo('/pricing'), '/pricing');
  assert.equal(sanitizeReturnTo('/account?x=1'), '/account?x=1');
});
test('rejects external / protocol-relative / junk', () => {
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'evil.com', '', null, undefined, '/a\nb']) {
    assert.equal(sanitizeReturnTo(bad), '/account');
  }
  assert.equal(sanitizeReturnTo('//x', '/pricing'), '/pricing');
});
