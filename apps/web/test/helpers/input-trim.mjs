// Shared by the tests that load GET /api/jobs/:id or JobView through a data-URL transpile:
// both import the REAL input-trim helper (src/lib/input-trim.ts, pure and import-free), the
// same way the route tests wire the real same-origin guard (./same-origin.mjs).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'input-trim.ts');

export const INPUT_TRIM_URL =
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(readFileSync(SRC, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString('base64');

/** Matches a `from '@/lib/input-trim'` import specifier. */
export const INPUT_TRIM_IMPORT_RE = /from ['"]@\/lib\/input-trim['"]/g;
