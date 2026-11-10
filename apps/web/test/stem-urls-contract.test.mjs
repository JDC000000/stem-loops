// Run: pnpm --filter web test
//
// lib/stem-urls.ts contract test.
//
// WHY THIS FILE EXISTS. The route contract test STUBS `@/lib/stem-urls`, so its
// assertion that "every minted URL is a PLAY key" was testing the stub. Nothing
// imported the real module, which meant `mintStemPlayUrl` could be changed to sign
// the WAV download key — the web half of the original 240-360 MB defect — and every
// suite would stay green. An M-9 reviewer demonstrated exactly that mutation
// surviving. These tests exercise the REAL signer.
//
// Same transpile-and-stub harness as the route test, but inverted: lib/stem-keys.ts
// is inlined for real (it is the key logic), and only the AWS SDK is stubbed, so the
// assertion lands on which key builder the signer actually calls.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src/lib/stem-urls.ts');
const KEYS = join(WEB, 'src/lib/stem-keys.ts');

const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const JOB = '550e8400-e29b-41d4-a716-446655440000';

// Records exactly what the signer asked to sign.
const s3Stub = () =>
  dataUrl(`
    export class GetObjectCommand {
      constructor(input) { this.input = input; globalThis.__su.commands.push(input); }
    }
  `);

const presignerStub = () =>
  dataUrl(`
    export const getSignedUrl = async (client, cmd, opts) => {
      globalThis.__su.signed.push({ key: cmd.input.Key, opts, disposition: cmd.input.ResponseContentDisposition });
      return 'https://r2.example/' + cmd.input.Key + '?X-Amz-Expires=' + (opts?.expiresIn ?? 0);
    };
  `);

const r2Stub = () => dataUrl(`export const r2 = { __client: true };`);

async function load() {
  let js = toJs(readFileSync(SRC, 'utf8'));
  js = js
    .replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${s3Stub()}'`)
    .replace(/from ['"]@aws-sdk\/s3-request-presigner['"]/g, `from '${presignerStub()}'`)
    .replace(/from ['"]@\/lib\/r2['"]/g, `from '${r2Stub()}'`)
    // the REAL key module — this is the logic under test
    .replace(/from ['"]@\/lib\/stem-keys['"]/g, `from '${dataUrl(toJs(readFileSync(KEYS, 'utf8')))}'`);
  return await import(dataUrl(js) + '#' + Math.random());
}

beforeEach(() => {
  globalThis.__su = { commands: [], signed: [] };
  process.env.R2_BUCKET_NAME = 'test-bucket';
});

test('mintStemPlayUrl signs the PLAY key — not the WAV download key', async () => {
  // THE MUTATION THIS KILLS: mintStemPlayUrl signing stemDownloadR2Key. That is the
  // web half of the original defect — serving 40-60 MB WAVs to a mixer whose memory
  // budget was measured at 287 MB for the whole song.
  const m = await load();
  const url = await m.mintStemPlayUrl(JOB, 'drums', 900);
  assert.equal(globalThis.__su.signed.length, 1);
  assert.equal(globalThis.__su.signed[0].key, `${JOB}/_stems/play/drums.opus`);
  assert.match(url, /\/_stems\/play\/drums\.opus/);
  assert.doesNotMatch(url, /_stems\/dl\//);
  assert.doesNotMatch(url, /\.wav/);
});

test('mintStemDownloadUrl signs the DOWNLOAD key — not the Opus key', async () => {
  const m = await load();
  await m.mintStemDownloadUrl(JOB, 'bass', 900);
  assert.equal(globalThis.__su.signed[0].key, `${JOB}/_stems/dl/bass.wav`);
});

test('the two signers never produce the same key for the same stem', async () => {
  const m = await load();
  await m.mintStemPlayUrl(JOB, 'vocals', 900);
  await m.mintStemDownloadUrl(JOB, 'vocals', 900);
  const [play, dl] = globalThis.__su.signed.map((s) => s.key);
  assert.notEqual(play, dl);
  assert.ok(play.endsWith('.opus'));
  assert.ok(dl.endsWith('.wav'));
});

test('the caller-supplied TTL is passed through to the presigner', async () => {
  // Kills a mutation that ignores expiresIn and uses an SDK default (3600s),
  // which would silently undo the route's min(900, remaining) clamp.
  const m = await load();
  await m.mintStemPlayUrl(JOB, 'drums', 137);
  assert.equal(globalThis.__su.signed[0].opts.expiresIn, 137);
});

test('playback URLs carry NO attachment disposition; downloads can', async () => {
  // A playback stem is streamed by the mixer. Forcing an attachment disposition
  // would make the browser try to download it instead of decode it.
  const m = await load();
  await m.mintStemPlayUrl(JOB, 'drums', 900);
  assert.equal(globalThis.__su.signed[0].disposition, undefined);

  globalThis.__su = { commands: [], signed: [] };
  await m.mintStemDownloadUrl(JOB, 'drums', 900, 'My Song - drums.wav');
  assert.match(globalThis.__su.signed[0].disposition, /^attachment; filename="My Song - drums\.wav"$/);
});

test('a download filename cannot inject a CR/LF or quote into the header', async () => {
  const m = await load();
  await m.mintStemDownloadUrl(JOB, 'drums', 900, 'evil"\r\nX-Injected: 1.wav');
  const d = globalThis.__su.signed[0].disposition;
  assert.doesNotMatch(d, /[\r\n]/);
  assert.equal((d.match(/"/g) || []).length, 2, 'exactly the two wrapping quotes');
});

test('the bucket comes from R2_BUCKET_NAME', async () => {
  const m = await load();
  await m.mintStemPlayUrl(JOB, 'drums', 900);
  assert.equal(globalThis.__su.commands[0].Bucket, 'test-bucket');
});
