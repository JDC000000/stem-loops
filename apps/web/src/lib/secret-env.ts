// Server secrets that must never fall back to a public default in production
// (QA track B, B-08).
//
// IP_HASH_KEY keys the stored client-IP hashes (lib/client-ip.ts). With the old
// `?? 'dev-key'` fallback, an unset variable in production meant every stored
// sha256(key + ip) could be reversed to the IP in minutes (the IPv4 space is small)
// with a key anyone can read in this repo. HISTORY_COOKIE_KEY signs the sl-history
// cookie; with `?? 'dev'` the cookie was forgeable.
//
// Rule: read lazily, at request time (never at module load: `next build` evaluates
// route modules with NODE_ENV=production and no runtime secrets). When the value is
// unset or blank and NODE_ENV is 'production', THROW, so the route answers its own
// 500 and the logs name the variable. Development and tests keep a fixed default.
//
// Pure and import-free so route tests can load it through a data-URL transpile.

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`${name} is not set. It is required in production (see AGENTS.md "Secret Convention").`);
    this.name = 'MissingSecretError';
  }
}

export function requiredSecret(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v !== undefined && v.trim() !== '') return v;
  if (process.env.NODE_ENV === 'production') throw new MissingSecretError(name);
  return devDefault;
}

/** Key for client-IP hashes. Dev/test default 'dev-key' (unchanged from before). */
export const ipHashKey = (): string => requiredSecret('IP_HASH_KEY', 'dev-key');

/** HMAC key for the sl-history cookie. Dev/test default 'dev' (unchanged from before). */
export const historyCookieKey = (): string => requiredSecret('HISTORY_COOKIE_KEY', 'dev');
