// Design v1.4, P7 copy rule: an error is ONE line saying what happened and ONE line saying
// what to do. Every ERROR_COPY entry is held to it: a non-empty headline and action, each a
// single sentence, and no implementation names (the separation model, its host, sample rates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = ts.transpileModule(readFileSync(join(WEB, 'src/lib/error-copy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ERROR_COPY, entitlementMessage } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

// Sentence ends: . ! ? followed by a space and a capital. "e.g." style abbreviations are not used.
const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);

test('every error: one sentence of what happened, one sentence of what to do', () => {
  for (const [code, { headline, action }] of Object.entries(ERROR_COPY)) {
    assert.ok(headline && headline.trim(), `${code}: empty headline`);
    assert.ok(action && action.trim(), `${code}: empty action — say what to do`);
    assert.equal(sentences(headline).length, 1, `${code}: headline is ${sentences(headline).length} sentences: ${headline}`);
    assert.equal(sentences(action).length, 1, `${code}: action is ${sentences(action).length} sentences: ${action}`);
    assert.doesNotMatch(`${headline} ${action}`, /demucs|replicate|klangio|\bmono\b|\bkHz\b/i, code);
    assert.equal(entitlementMessage(code), `${headline} ${action}`, `${code}: rendered as the two lines`);
  }
});
