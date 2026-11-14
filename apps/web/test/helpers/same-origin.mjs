// Shared by the route contract tests that load a route through a data-URL
// transpile: the routes import the REAL same-origin guard (src/lib/same-origin.ts,
// pure and import-free), and their requests carry a same-origin Origin/Host pair
// so the guard lets them through. Refusals are covered in same-origin-guard.test.mjs.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'same-origin.ts');

export const SAME_ORIGIN_URL =
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(readFileSync(SRC, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString('base64');

/** Matches the route's `from '@/lib/same-origin'` import specifier. */
export const SAME_ORIGIN_IMPORT_RE = /from ['"]@\/lib\/same-origin['"]/g;

/** A same-origin browser request's Origin + Host (lowercase keys, for Map-backed stubs too). */
export const SAME_ORIGIN_HEADERS = Object.freeze({ origin: 'https://stem-loops.com', host: 'stem-loops.com' });

/** Header bag for a same-origin request: works as a Map-backed or Headers-backed stub. */
export const sameOriginHeaders = () => new Map(Object.entries(SAME_ORIGIN_HEADERS));

/** Minimal same-origin request for routes that read nothing but headers. */
export const sameOriginReq = (extra = {}) => ({ headers: sameOriginHeaders(), ...extra });
