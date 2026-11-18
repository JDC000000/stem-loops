// SF-4 (PR #290 review round 2): J1's "Recent jobs" predicate must tell a written title from the
// original_filename fallback, so CI catches the worker no longer writing jobs.title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recentListsUploadByTitle } from '../journeys/recent-label.mjs';

const ID = '3f2a9c1e-7b44-4d2a-9a51-0c6f1e2b8d77';

test('the title (file name without .mp3) passes', () => {
  assert.equal(recentListsUploadByTitle('Recent jobs journey-song-40s-120bpm Done', ID), true);
});

test('the original_filename fallback (".mp3" shown) FAILS: the title write did not happen', () => {
  assert.equal(recentListsUploadByTitle('Recent jobs journey-song-40s-120bpm.mp3 Done', ID), false);
  assert.equal(recentListsUploadByTitle('Recent jobs journey-song-40s-120bpm.MP3 Done', ID), false);
  assert.equal(recentListsUploadByTitle('Recent jobs something-else.mp3 Done', ID), false);
});

test('a job shown by its id fails, and so does a list without the upload', () => {
  assert.equal(recentListsUploadByTitle(`Recent jobs journey-song-40s-120bpm ${ID} Done`, ID), false);
  assert.equal(recentListsUploadByTitle(`Recent jobs ${ID} Done`, ID), false);
  assert.equal(recentListsUploadByTitle('', ID), false);
  assert.equal(recentListsUploadByTitle(undefined, ID), false);
});

test('j1 uses this predicate for its Recent jobs check', () => {
  const src = readFileSync(new URL('../journeys/j1-first-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ recentListsUploadByTitle \} from '\.\/recent-label\.mjs';/);
  assert.match(src, /recentListsUploadByTitle\(recent, jobId\)/);
  assert.doesNotMatch(src, /\|\| \/\\\.mp3\/\.test\(recent\)/, 'the old ".mp3 passes" branch is back');
});
