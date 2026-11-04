import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sslFor, sanitizeSupabaseConn } from '../src/lib/db-ssl.ts';

// sslFor — picks { rejectUnauthorized: false } for Supabase hosts only.
test('sslFor: Supabase host gets rejectUnauthorized:false', () => {
  assert.deepEqual(
    sslFor('postgresql://u:p@db.abc.supabase.co:5432/postgres'),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    sslFor('postgresql://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres'),
    { rejectUnauthorized: false },
  );
});
test('sslFor: non-Supabase host returns undefined (no TLS override)', () => {
  assert.equal(sslFor('postgresql://u:p@localhost:5432/postgres'), undefined);
  assert.equal(sslFor('postgresql://u:p@rds.amazonaws.com:5432/x'), undefined);
  assert.equal(sslFor(undefined), undefined);
  assert.equal(sslFor(''), undefined);
});

// sanitizeSupabaseConn — strips sslmode from Supabase URLs so our explicit
// ssl config in new Pool() is the only source of TLS behavior.
test('sanitizeSupabaseConn: strips sslmode=require from Supabase pooler URL', () => {
  const input =
    'postgresql://postgres.abc:pw@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?sslmode=require';
  const got = sanitizeSupabaseConn(input);
  assert.ok(!got.includes('sslmode'), `expected sslmode stripped, got: ${got}`);
  assert.ok(got.includes('postgres.abc:pw'), 'preserves user:password');
  assert.ok(got.includes('pooler.supabase.com:6543/postgres'), 'preserves host/port/db');
});

test('sanitizeSupabaseConn: strips all sslmode variants', () => {
  for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']) {
    const url = `postgresql://u:p@db.abc.supabase.co/postgres?sslmode=${mode}`;
    const got = sanitizeSupabaseConn(url);
    assert.ok(!got.includes('sslmode'), `expected sslmode=${mode} stripped, got: ${got}`);
  }
});

test('sanitizeSupabaseConn: strips uselibpqcompat too (redundant with explicit ssl)', () => {
  const input = 'postgresql://u:p@db.abc.supabase.co/postgres?uselibpqcompat=true&sslmode=require';
  const got = sanitizeSupabaseConn(input);
  assert.ok(!got.includes('sslmode'));
  assert.ok(!got.includes('uselibpqcompat'));
});

test('sanitizeSupabaseConn: preserves other query params', () => {
  const input =
    'postgresql://u:p@db.abc.supabase.co/postgres?sslmode=require&application_name=stemloops&connect_timeout=10';
  const got = sanitizeSupabaseConn(input);
  assert.ok(!got.includes('sslmode'));
  assert.ok(got.includes('application_name=stemloops'));
  assert.ok(got.includes('connect_timeout=10'));
});

test('sanitizeSupabaseConn: non-Supabase URL returned unchanged', () => {
  const input = 'postgresql://u:p@localhost:5432/postgres?sslmode=require';
  assert.equal(sanitizeSupabaseConn(input), input);
});

test('sanitizeSupabaseConn: malformed URL returned unchanged (so pg surfaces its own error)', () => {
  const input = 'not a url at all';
  assert.equal(sanitizeSupabaseConn(input), input);
});
