// Shared by the /api/jobs contract tests that load route.ts through a data-URL transpile.
// Since Phase B B0 the route's signed-in link path lives in src/lib/jobs/create-link-job.ts.
// That module has NO runtime imports (the route hands it its own imports as `deps`), so the
// REAL module runs against whatever stubs a test already wires into the route. This helper
// mirrors helpers/same-origin.mjs: a data URL of the transpiled module and the regex for the
// route's import specifier.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const LINK_JOB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'jobs', 'create-link-job.ts');

export const linkJobJs = (src = readFileSync(LINK_JOB_SRC, 'utf8')) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const js = linkJobJs();
// Guard the premise: if the module ever gains a runtime import, every loader that relies on
// this helper would silently resolve it from a data: URL and fail far from the cause.
if (/^\s*import\s+(?!type\b)[^;]*from\s+['"]/m.test(js) || /\bimport\(/.test(js)) {
  throw new Error('src/lib/jobs/create-link-job.ts must stay import-free at runtime (pass dependencies via deps)');
}

export const LINK_JOB_URL = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

/** Matches the route's `from '@/lib/jobs/create-link-job'` import specifier. */
export const LINK_JOB_IMPORT_RE = /from ['"]@\/lib\/jobs\/create-link-job['"]/g;

// #372: route.ts also imports `pasteHooks` from '@/lib/library-server' (the signed-in paste's
// dedupe hooks). Contract tests whose subject is NOT the dedupe wire this inert stand-in, so
// their fake databases see exactly the statements they saw before: no hooks → the lib runs
// byte-for-byte the B0 path. The dedupe itself is proven against the REAL module by
// test/jobs-link-dedupe.test.mjs (fakes) and test/jobs-link-dedupe-pg.test.mjs (real Postgres).
export const NO_PASTE_HOOKS_URL =
  'data:text/javascript;base64,' + Buffer.from('export const pasteHooks = () => ({});').toString('base64');

/** Matches the route's `from '@/lib/library-server'` import specifier. */
export const LIBRARY_SERVER_IMPORT_RE = /from ['"]@\/lib\/library-server['"]/g;
