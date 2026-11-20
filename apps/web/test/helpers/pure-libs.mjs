// Shared by route contract tests that load a route through a data-URL transpile.
//
// The QA track B hardening added a few PURE, import-free helpers that routes now import:
//   @/lib/secret-env      (B-08: IP_HASH_KEY / HISTORY_COOKIE_KEY fail closed in production)
//   @/lib/app-url         (B-07: redirect origin from config, not the Origin header)
//   @/lib/read-rate-limit (B-11: in-process limiter on job reads)
//   @/lib/same-origin     (B-06)
//   @/lib/billing/checkout-guard (decision 1A: the plan-checkout live-subscription block)
//   @/lib/client-ip       (a STUB: hash = the request's x-forwarded-for, else 'test-ip'; the
//                          real module is tested on its own in client-ip-secret.test.mjs)
// wirePureLibs(js) points any of those specifiers STILL PRESENT in `js` at the real
// transpiled module, so a harness that already stubs one keeps its stub. The limiter gets a
// fresh module instance per call (its window Map must not leak between test cases).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib');
const toJs = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const lib = (name) => toJs(readFileSync(join(LIB, name), 'utf8'));

export const SECRET_ENV_URL = dataUrl(lib('secret-env.ts'));
export const APP_URL_URL = dataUrl(lib('app-url.ts'));
export const SAME_ORIGIN_LIB_URL = dataUrl(lib('same-origin.ts'));
export const CHECKOUT_GUARD_URL = dataUrl(lib('billing/checkout-guard.ts'));
const READ_LIMIT_JS = lib('read-rate-limit.ts');
export const CLIENT_IP_URL = dataUrl(
  "export const clientIpHashOf = (r) => r?.headers?.get?.('x-forwarded-for') ?? 'test-ip';" +
    "\nexport const clientIp = clientIpHashOf; export const hashIp = (ip) => 'h:' + ip;",
);

let n = 0;
export function wirePureLibs(js) {
  const readLimit = dataUrl(READ_LIMIT_JS + `\n// instance ${++n}-${Math.random()}\n`);
  return js
    .replace(/from ['"]@\/lib\/secret-env['"]/g, `from '${SECRET_ENV_URL}'`)
    .replace(/from ['"]@\/lib\/app-url['"]/g, `from '${APP_URL_URL}'`)
    .replace(/from ['"]@\/lib\/read-rate-limit['"]/g, `from '${readLimit}'`)
    .replace(/from ['"]@\/lib\/same-origin['"]/g, `from '${SAME_ORIGIN_LIB_URL}'`)
    .replace(/from ['"]@\/lib\/client-ip['"]/g, `from '${CLIENT_IP_URL}'`)
    .replace(/from ['"]@\/lib\/billing\/checkout-guard['"]/g, `from '${CHECKOUT_GUARD_URL}'`);
}
