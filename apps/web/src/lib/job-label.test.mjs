// /account "Recent jobs" labelled every upload by its UUID (W4 j1, 2026-11-13):
// jobs.title is NULL for uploads and the page fell back to the id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobLabel } from './job-label.ts';

const ID = '90907f5c-1577-423c-b1c4-52ea6a785bfe';
const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'account', 'page.tsx');

test('upload job with NULL title is labelled by its file name, not its id', () => {
  assert.equal(jobLabel({ id: ID, title: null, original_filename: 'w4-song-40s-120bpm.mp3' }), 'w4-song-40s-120bpm.mp3');
});

test('title wins when set; blank strings fall through', () => {
  assert.equal(jobLabel({ id: ID, title: 'My Song', original_filename: 'a.mp3' }), 'My Song');
  assert.equal(jobLabel({ id: ID, title: '  ', original_filename: 'a.mp3' }), 'a.mp3');
});

test('link job falls back to its URL, and the id is the last resort', () => {
  assert.equal(
    jobLabel({ id: ID, title: null, original_filename: null, youtube_url: 'https://youtu.be/x' }),
    'https://youtu.be/x',
  );
  assert.equal(jobLabel({ id: ID, title: null, original_filename: null, youtube_url: null }), ID);
  assert.equal(jobLabel({ id: ID }), ID);
});

test('account page selects original_filename and labels rows with jobLabel', () => {
  const src = readFileSync(PAGE, 'utf8');
  const select = /SELECT([\s\S]*?)FROM public\.jobs/.exec(src);
  assert.ok(select, 'recentJobs SELECT not found');
  assert.match(select[1], /\boriginal_filename\b/);
  assert.match(src, /\{jobLabel\(j\)\}/);
  assert.doesNotMatch(src, /\{j\.title \|\| j\.id\}/);
});
