// Server secrets that must never fall back to a public default in PRODUCTION
// (QA track B, B-08).
//
// IP_HASH_KEY keys the stored client-IP hashes (lib/client-ip.ts). With the old
// `?? 'dev-key'` fallback, an unset variable in production meant every stored
// sha256(key + ip) could be reversed to the IP in minutes (the IPv4 space is small)
// with a key anyone can read in this repo. HISTORY_COOKIE_KEY signs the sl-history
// cookie; with `?? 'dev'` the cookie was forgeable.
//
// WHAT "PRODUCTION" MEANS HERE: `VERCEL_ENV === 'production'` (Vercel sets it on the
// production deployment of a project only). NOT `NODE_ENV === 'production'`: that is
// also true on every Vercel preview, on the separate staging project and in any local
// `next start`, and as of 2026-11-18 (env NAMES read, no values):
//     stem-loops-web      IP_HASH_KEY: production+preview+development
//                         HISTORY_COOKIE_KEY: production only
//     stem-loops-staging  neither
// so a NODE_ENV rule would break history and account deletion on every web preview and
// the whole staging site. The codebase has no other "this is production" flag for a
// non-Vercel host, so none is consulted.
//
// Rule: read lazily, at request time (never at module load: `next build` evaluates
// route modules with no runtime secrets).
//   • set and non-blank            → the value
//   • unset/blank, VERCEL_ENV=production → THROW (the route answers its own 500 and the
//                                    logs name the variable)
//   • unset/blank anywhere else    → the old dev default, plus ONE structured warning per
//                                    variable per process when NODE_ENV is 'production'
//                                    (a preview/staging/`next start` build), so the gap is
//                                    visible in logs without taking the deployment down.
//
// Pure and import-free so route tests can load it through a data-URL transpile.

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`${name} is not set. It is required in production (see AGENTS.md "Secret Convention").`);
    this.name = 'MissingSecretError';
  }
}

const warned = new Set<string>();

export function requiredSecret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v !== undefined && v.trim() !== '') return v;
  if (process.env.VERCEL_ENV === 'production') throw new MissingSecretError(name);
  if (process.env.NODE_ENV === 'production' && !warned.has(name)) {
    warned.add(name);
    console.warn(
      JSON.stringify({
        level: 'WARN',
        event: 'secret_env_default_used',
        variable: name,
        vercel_env: process.env.VERCEL_ENV ?? null,
        detail: `${name} is unset outside Vercel production; using the public development default.`,
      }),
    );
  }
  return devDefault;
}

/** Key for client-IP hashes. Dev/test/preview default 'dev-key' (unchanged from before). */
export const ipHashKey = (): string => requiredSecret('IP_HASH_KEY', 'dev-key');

/** HMAC key for the sl-history cookie. Dev/test/preview default 'dev' (unchanged from before). */
export const historyCookieKey = (): string => requiredSecret('HISTORY_COOKIE_KEY', 'dev');
