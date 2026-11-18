// QA track B, B-02: the image optimizer must be off, and there must be one Next config file.
//
// The app renders no next/image, but /_next/image answered 200 on production and Next 14.2.x
// carries image-optimizer advisories with no 14.2 fix. `images.unoptimized` turns the
// endpoint off. Next loads next.config.js BEFORE next.config.mjs, so the .mjs that used to sit
// beside it was dead code: an edit there would look applied and change nothing.
//
// This loads the REAL config (through withSentryConfig) rather than grepping it, so a config
// that is wrapped, re-exported or overwritten later in the file is judged by what Next sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadConfig() {
  const mod = require(join(WEB, 'next.config.js'));
  return typeof mod === 'function' ? await mod('phase-production-build', { defaultConfig: {} }) : mod;
}

test('next.config.js turns the image optimizer off', async () => {
  const cfg = await loadConfig();
  assert.equal(cfg.images?.unoptimized, true, `images = ${JSON.stringify(cfg.images)}`);
});

test('next.config.js keeps the settings the deleted next.config.mjs had', async () => {
  const cfg = await loadConfig();
  assert.deepEqual(cfg.transpilePackages, ['@stem-loops/types']);
});

test('exactly one Next config file exists (no dead next.config.mjs / .ts beside the live .js)', () => {
  for (const f of ['next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    assert.equal(existsSync(join(WEB, f)), false, `${f} exists beside next.config.js; Next ignores it`);
  }
});

test('the app does not import next/image (so unoptimized changes no rendered page)', () => {
  const { execFileSync } = require('node:child_process');
  let hits = '';
  try {
    hits = execFileSync('grep', ['-rlE', "from ['\"]next/(legacy/)?image['\"]", join(WEB, 'src')], {
      encoding: 'utf8',
    });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match
  }
  assert.equal(hits.trim(), '', `next/image is imported in:\n${hits}`);
  assert.ok(readFileSync(join(WEB, 'src/app/history/page.tsx'), 'utf8').includes('<img'));
});
