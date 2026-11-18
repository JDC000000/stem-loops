// Shared stubs for the route harnesses that load job-scoped routes (Slice 2a).
//
// `jobAccessUrl(getUserSpecifier)`: the REAL src/lib/job-access.ts, with its one import
// (`@/lib/auth/supabase`) pointed at the harness's own getUser stub. Routes that now ask the
// central rule (loops, download) get the real rule, not a stub that could disagree with it.
//
// `DEMO_RATE_URL`: src/lib/demo-rate.ts, stubbed. `globalThis.__demoRateAllowed === false`
// refuses; anything else allows. `globalThis.__demoRateCalls` counts calls, so a harness can
// prove an ordinary job never reaches the demo limiter.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

export const JOB_ACCESS_IMPORT_RE = /from ['"]@\/lib\/job-access['"]/g;
export const DEMO_RATE_IMPORT_RE = /from ['"]@\/lib\/demo-rate['"]/g;

export function jobAccessUrl(getUserSpecifier) {
  return dataUrl(
    toJs(readFileSync(join(WEB, 'src/lib/job-access.ts'), 'utf8')).replace(
      /from ['"]@\/lib\/auth\/supabase['"]/g,
      `from '${getUserSpecifier}'`,
    ),
  );
}

export const DEMO_RATE_URL = dataUrl(`
  export const DEMO_RATE_LIMIT_MSG = "You're sending requests too fast. Wait a minute and try again.";
  export const demoReadAllowed = async () => {
    globalThis.__demoRateCalls = (globalThis.__demoRateCalls ?? 0) + 1;
    return globalThis.__demoRateAllowed !== false;
  };
`);
