// canonicalizeYoutubeUrl: scheme-less pastes are accepted, host allowlist stays strict.
// Dependency-free (node:test + the existing `typescript` devDependency), same as sentry-guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/lib/youtube-url.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { canonicalizeYoutubeUrl, withScheme, youtubeUrlProblem } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

const ID = 'dQw4w9WgXcQ';
const CANON = `https://www.youtube.com/watch?v=${ID}`;

test('accepts full https links (unchanged behaviour)', () => {
  for (const u of [
    `https://www.youtube.com/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
  ]) assert.equal(canonicalizeYoutubeUrl(u), CANON, u);
});

test('accepts scheme-less links on every allowlisted host', () => {
  for (const u of [
    `youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `m.youtube.com/watch?v=${ID}`,
    `music.youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
    `www.youtube.com/shorts/${ID}`,
    `  YouTube.com/watch?v=${ID}  `,
  ]) assert.equal(canonicalizeYoutubeUrl(u), CANON, u);
});

test('keeps the host allowlist strict', () => {
  for (const u of [
    `evil.com/watch?v=${ID}`,
    `youtube.com.evil.com/watch?v=${ID}`,
    `notyoutube.com/watch?v=${ID}`,
    `youtube.com@evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://evil.com/?u=youtube.com/watch?v=${ID}`,
    `//youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `soundcloud.com/artist/track`,
  ]) assert.equal(canonicalizeYoutubeUrl(u), null, u);
});

test('still requires a real 11-character video id', () => {
  for (const u of ['youtube.com/watch', 'youtu.be/', 'youtube.com/watch?v=short', `youtube.com/shorts/${ID}x`, 'banana', ''])
    assert.equal(canonicalizeYoutubeUrl(u), null, u);
});

test('withScheme only touches scheme-less YouTube hosts', () => {
  assert.equal(withScheme(`youtu.be/${ID}`), `https://youtu.be/${ID}`);
  assert.equal(withScheme(`https://youtu.be/${ID}`), `https://youtu.be/${ID}`);
  assert.equal(withScheme('example.com/x'), 'example.com/x');
  assert.equal(withScheme('youtube.com'), 'youtube.com'); // no path → left alone, then rejected
});

test('youtubeUrlProblem names the reason a paste was rejected', () => {
  assert.equal(youtubeUrlProblem('https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs'), 'playlist');
  assert.equal(youtubeUrlProblem('youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs'), 'playlist');
  assert.equal(youtubeUrlProblem('https://www.youtube.com/@someartist'), 'channel');
  assert.equal(youtubeUrlProblem('youtube.com/channel/UC123'), 'channel');
  assert.equal(youtubeUrlProblem('https://soundcloud.com/a/b'), 'other');
  assert.equal(youtubeUrlProblem('banana'), 'url');
  assert.equal(youtubeUrlProblem('youtu.be/'), 'url');
});
