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

// ── control characters ──────────────────────────────────────────────────────────────────────
// WHY THESE ARE PINNED. The WHATWG URL parser deletes TAB, CR and LF from anywhere in its input
// BEFORE parsing, so "/<TAB>/evil.com" is "//evil.com" to a browser or to `new URL(...)`: a
// protocol-relative URL, i.e. an external host. The startsWith('//') guard above cannot see it
// because the raw string has a TAB between the slashes. The only thing stopping it is the
// control-character class in sanitizeReturnTo. Narrowing that class to allow TAB (or CR, or LF)
// is a one-character edit that turned `/\t/evil.com` into a working open redirect, and no test
// here failed (found by adversarial review, 2026-11-12).
const ORIGIN = 'https://stem-loops.com';

test('control characters between the slashes: refused, and the reason is real', () => {
  for (const raw of ['/\t/evil.com', '/\r/evil.com', '/\n/evil.com', '/\r\n/evil.com', '/\t\t/evil.com', '/\u0000/evil.com', '/\u000b/evil.com', '/\u000c/evil.com', '/\u001f/evil.com']) {
    assert.equal(sanitizeReturnTo(raw), '/account', JSON.stringify(raw));
    assert.equal(sanitizeReturnTo(raw, '/pricing'), '/pricing', JSON.stringify(raw));
  }
  // The reason, so a future "TAB is harmless" edit has to argue with the platform and not with us.
  for (const raw of ['/\t/evil.com', '/\r/evil.com', '/\n/evil.com']) {
    assert.equal(new URL(raw, ORIGIN).origin, 'https://evil.com', `${JSON.stringify(raw)} no longer leaves the origin; revisit this test`);
  }
});

// ── the hostile set ─────────────────────────────────────────────────────────────────────────
// The property that matters is not "returns the fallback" (some of these are legitimately
// same-origin paths) but "whatever comes back resolves to OUR origin".
const HOSTILE = [
  '//evil.com', '///evil.com', '////evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com', '\\evil.com',
  'https://evil.com', 'http://evil.com', 'HTTPS://EVIL.COM', 'https://stem-loops.com@evil.com',
  'https:evil.com', 'https:/evil.com', '//evil.com\\@stem-loops.com', ' //evil.com', ' https://evil.com',
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
  'vbscript:x', 'file:///etc/passwd', 'mailto:x@evil.com', 'tel:123',
  'evil.com', 'evil.com/x', '', ' ', '∕∕evil.com',
  '/\t/evil.com', '/\r/evil.com', '/\n/evil.com', '/\r\n/evil.com', '/\t\t/evil.com', '/\u0000/evil.com',
  '/\u000b/evil.com', '/\u000c/evil.com', '/\u001f/evil.com', '/a\r\nSet-Cookie: x=1', '/a\nb',
  '/%2F/evil.com', '/%5Cevil.com', '/%09/evil.com', '/∕evil.com', '/／evil.com', '/⁄evil.com',
  '/ /evil.com', '/ /evil.com', '/​/evil.com', '/.//evil.com', '/..//evil.com', '/@evil.com',
];

test(`${HOSTILE.length} hostile inputs: every result resolves same-origin`, () => {
  assert.ok(HOSTILE.length >= 50);
  for (const raw of HOSTILE) {
    for (const fallback of ['/account', '/pricing']) {
      const out = sanitizeReturnTo(raw, fallback);
      assert.equal(new URL(out, ORIGIN).origin, ORIGIN, `${JSON.stringify(raw)} -> ${JSON.stringify(out)} leaves the origin`);
    }
  }
});

test('multi-parameter sanity: legitimate paths with queries and fragments are returned untouched', () => {
  for (const ok of ['/jobs/abc-123', '/pricing?a=1&b=2', '/pricing#frag', '/jobs/abc-123?x=1&next=//evil.com']) {
    assert.equal(sanitizeReturnTo(ok), ok);
  }
});
