// Unit tests for the completed-job chord loader (PR-Y1.qa-T4).
//
// The React hook itself is exercised via Playwright in the e2e suite (once
// PR #95 lands and the ChordOverlay typechecks clean). Here we cover the
// pure fetch primitive — `fetchPlayChords(jobId)` — because that's where the
// on-wire contract between the worker's play.chords.json and the web overlay
// is actually enforced:
//
//   1. GET /api/jobs/<id>/play-chords → signed URL envelope
//   2. GET <signed_url>               → ChordResult-shape JSON
//   3. Parsed ChordObservation[] back to the caller
//
// Run with: `node --experimental-strip-types --test src/chord/__tests__/play-chords-loader.test.mjs`
// or `pnpm --filter web test`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchPlayChords } from '../play-chords-loader.ts';

// ---- fetch-mock plumbing ----------------------------------------------------
let originalFetch;
let calls;

function makeResponse({ status = 200, json = {}, ok } = {}) {
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    json: async () => json,
  };
}

/** Program a sequence of fetch responses. The Nth fetch call returns responses[N-1]. */
function mockFetchSequence(responses) {
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const resp = responses[i++];
    if (!resp) throw new Error(`unexpected fetch #${i}: ${url}`);
    return resp;
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- happy path -------------------------------------------------------------
test('fetchPlayChords: hits /api/jobs/<id>/play-chords, follows signed URL, parses segments', async () => {
  const signedUrl = 'https://r2.example.com/jobs/job-abc/play.chords.json?sig=xyz';
  mockFetchSequence([
    // Tier 1: API envelope
    makeResponse({
      status: 200,
      json: { signed_url: signedUrl, expires_in_sec: 300 },
    }),
    // Tier 2: the R2 object itself (matches the ChordResult dataclass shape)
    makeResponse({
      status: 200,
      json: {
        segments: [
          { start_sec: 0.0, end_sec: 1.6, label: 'C:maj', confidence: 1.0 },
          { start_sec: 1.6, end_sec: 3.2, label: 'F:maj', confidence: 1.0 },
          { start_sec: 3.2, end_sec: 4.8, label: 'G:7', confidence: 0.9 },
        ],
        key: 'C:major',
        provider: 'klangio',
        provider_version: '2026-11-04',
        duration_sec: 4.8,
        model_ms: 123,
      },
    }),
  ]);

  const observations = await fetchPlayChords('job-abc');

  // First call: the API route for this job id (the "signed URL path").
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/jobs/job-abc/play-chords');
  // Second call: the signed URL we got back verbatim.
  assert.equal(calls[1].url, signedUrl);

  // Parsed ChordObservation[]: snake_case → camelCase, label preserved.
  assert.ok(Array.isArray(observations));
  assert.equal(observations.length, 3);
  assert.deepEqual(observations[0], {
    startSec: 0.0,
    endSec: 1.6,
    label: 'C:maj',
    confidence: 1.0,
  });
  assert.equal(observations[2].label, 'G:7');
  assert.equal(observations[2].confidence, 0.9);
});

// ---- 404 → null -------------------------------------------------------------
test('fetchPlayChords: 404 at the API route returns null without touching R2', async () => {
  mockFetchSequence([
    makeResponse({ status: 404, json: { error_code: 'NOT_FOUND' } }),
  ]);

  const result = await fetchPlayChords('job-missing');

  assert.equal(result, null);
  // Exactly one call — we never attempt the R2 fetch when there's no envelope.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/jobs/job-missing/play-chords');
});

test('fetchPlayChords: 404 at the signed-URL fetch also returns null', async () => {
  mockFetchSequence([
    makeResponse({
      status: 200,
      json: {
        signed_url: 'https://r2.example.com/jobs/job-gone/play.chords.json?sig=expired',
        expires_in_sec: 300,
      },
    }),
    makeResponse({ status: 404, json: {} }),
  ]);

  const result = await fetchPlayChords('job-gone');

  assert.equal(result, null);
  assert.equal(calls.length, 2);
});

// ---- resilience: empty / malformed segments --------------------------------
test('fetchPlayChords: empty segments array returns an empty array (not null)', async () => {
  mockFetchSequence([
    makeResponse({
      status: 200,
      json: { signed_url: 'https://r2/x', expires_in_sec: 300 },
    }),
    makeResponse({
      status: 200,
      json: { segments: [], key: null, provider: 'klangio' },
    }),
  ]);

  const result = await fetchPlayChords('job-empty');
  assert.deepEqual(result, []);
});

test('fetchPlayChords: drops malformed segments without failing the whole fetch', async () => {
  mockFetchSequence([
    makeResponse({
      status: 200,
      json: { signed_url: 'https://r2/x', expires_in_sec: 300 },
    }),
    makeResponse({
      status: 200,
      json: {
        segments: [
          { start_sec: 0, end_sec: 1, label: 'C:maj', confidence: 1 },
          { start_sec: 'not-a-number', end_sec: 1, label: 'D:maj', confidence: 1 },
          { start_sec: 2, end_sec: 3, label: '', confidence: 1 }, // empty label dropped
          null, // null row dropped
          { start_sec: 4, end_sec: 5, label: 'G:7' }, // missing confidence defaults to 1
        ],
      },
    }),
  ]);

  const result = await fetchPlayChords('job-mixed');
  assert.equal(result.length, 2);
  assert.equal(result[0].label, 'C:maj');
  assert.equal(result[1].label, 'G:7');
  assert.equal(result[1].confidence, 1);
});

// ---- hard failure propagation ----------------------------------------------
test('fetchPlayChords: 500 at the API route throws (lets Sentry surface it)', async () => {
  mockFetchSequence([
    makeResponse({ status: 500, json: {} }),
  ]);

  await assert.rejects(
    () => fetchPlayChords('job-boom'),
    /play-chords API 500/,
  );
});

test('fetchPlayChords: missing signed_url in envelope throws', async () => {
  mockFetchSequence([
    makeResponse({ status: 200, json: { expires_in_sec: 300 } }),
  ]);

  await assert.rejects(
    () => fetchPlayChords('job-bad-envelope'),
    /missing signed_url/,
  );
});
