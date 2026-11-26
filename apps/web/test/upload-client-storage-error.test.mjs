// QW-3: a non-2xx answer from R2 to the presigned upload PUT must not show the user the raw
// provider body (XML <Error><Code>…), the HTTP status line or the storage host. The user sees
// error-copy.ts UPLOAD_STORAGE_REJECTED_MSG (under ToolForm's head "The upload didn’t finish.");
// the raw body stays in console.error for diagnosis.
//
// Instrument: the REAL lib/upload-client.ts and lib/error-copy.ts (module graph) with a fake
// XMLHttpRequest that answers each PUT from a script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const graph = buildModuleGraph({ name: 'upload-client-storage-error', entries: ['lib/upload-client.ts'] });
const { putToR2 } = await import(graph.url('lib/upload-client.ts'));
const { UPLOAD_STORAGE_REJECTED_MSG } = await import(graph.url('lib/error-copy.ts'));

const XML = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>'
  + '<Message>The request signature we calculated does not match</Message></Error>';

let script = [];
let puts = 0;
class FakeXHR {
  constructor() { this.upload = {}; this.status = 0; this.statusText = ''; this.readyState = 0; this.responseText = ''; }
  open() {}
  setRequestHeader() {}
  send() {
    puts += 1;
    const step = script.shift();
    queueMicrotask(() => {
      if (step.kind === 'network') { this.onerror(); return; }
      Object.assign(this, { status: step.status, statusText: step.statusText ?? '', readyState: 4, responseText: step.body ?? '' });
      this.onload();
    });
  }
}
globalThis.XMLHttpRequest = FakeXHR;

async function run(steps) {
  script = [...steps];
  puts = 0;
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a);
  try {
    await putToR2('https://acct.r2.cloudflarestorage.com/bucket/k?X-Amz-Signature=x', { size: 1 }, 'audio/mpeg', () => {});
    return { err: null, logged };
  } catch (e) {
    return { err: e, logged };
  } finally {
    console.error = orig;
  }
}

for (const [status, statusText, body] of [
  [403, 'Forbidden', XML],
  [400, 'Bad Request', '<Error><Code>ExpiredRequest</Code></Error>'],
  [500, 'Internal Server Error', ''],
]) {
  test(`QW-3: HTTP ${status} from storage → the friendly line, no XML / status / host; raw body logged`, async () => {
    const { err, logged } = await run([{ status, statusText, body }]);
    assert.ok(err instanceof Error);
    assert.equal(err.message, UPLOAD_STORAGE_REJECTED_MSG);
    assert.doesNotMatch(err.message, /<|HTTP|\d{3}|Storage rejected|cloudflarestorage|Code/);
    assert.equal(puts, 1, 'a definitive storage answer is not retried');
    const entry = logged.find((a) => a[0] === '[upload] storage rejected PUT');
    assert.ok(entry, 'the raw answer is still logged for diagnosis');
    assert.equal(entry[1].status, status);
    assert.equal(entry[1].body, body.slice(0, 300));
  });
}

test('QW-3: the copy is one short sentence from error-copy.ts', () => {
  assert.equal(UPLOAD_STORAGE_REJECTED_MSG, 'Choose the file again and retry.');
  const src = readFileSync(join(WEB, 'src/lib/upload-client.ts'), 'utf8');
  assert.match(src, /new Error\(UPLOAD_STORAGE_REJECTED_MSG\)/);
  assert.doesNotMatch(src, /Storage rejected the upload/);
});

test('QW-3: a network error then a storage rejection → still the friendly line (retry path unchanged)', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // skip the 1.5 s backoff
  try {
    const { err } = await run([{ kind: 'network' }, { status: 403, statusText: 'Forbidden', body: XML }]);
    assert.equal(puts, 2);
    assert.equal(err.message, UPLOAD_STORAGE_REJECTED_MSG);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('QW-3: a 2xx resolves (no error)', async () => {
  const { err } = await run([{ status: 200 }]);
  assert.equal(err, null);
});
