// The `sl-history` cookie, read server-side.
//
// `api/history/set-cookie` writes an HMAC-signed, httpOnly mirror of the
// browser's localStorage history: `base64(JSON.stringify(jobIds)).hexsig`,
// newest first, capped at 20. This module owns BOTH halves of reading it —
// signature verification and the "newest live job" lookup — so the verify
// logic exists once. `api/history/route.ts` calls `verifyHistoryCookie` too;
// before this file the same createHmac/timingSafeEqual block was inlined
// there, and a second copy in the nav would have been a second place for it
// to drift.
//
// Why the nav wants this at all: a global header cannot link to `/jobs/<id>`
// without an id, and the alternative — a `SELECT … ORDER BY created_at LIMIT 1`
// on every signed-in page render — adds a Postgres round trip and a new
// failure mode to seven route subtrees. The cookie is already written, already
// signed, and already on the request.
import { createHmac, timingSafeEqual } from 'crypto';

/** What a history cookie turned out to be. `tampered` mirrors the shape
 * `GET /api/history` has always returned, so this refactor changes no
 * response body. */
export type HistoryCookie = { jobIds: string[]; tampered?: true };

/**
 * Parse and AUTHENTICATE the cookie. The signature is checked before the
 * payload is parsed, so a hand-edited cookie can never put an attacker-chosen
 * id into a nav href. A missing or malformed cookie yields no ids and no
 * `tampered` flag; a present cookie whose signature does not verify yields
 * `tampered: true`, as the route reported before this moved out of it.
 */
export function readHistoryCookie(raw: string | undefined | null): HistoryCookie {
  if (!raw || !raw.includes('.')) return { jobIds: [] };

  const idx = raw.lastIndexOf('.');
  const b64 = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);

  let payload: string;
  try {
    payload = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return { jobIds: [], tampered: true };
  }

  const expected = createHmac('sha256', process.env.HISTORY_COOKIE_KEY ?? 'dev')
    .update(payload)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { jobIds: [], tampered: true };

  try {
    const v: unknown = JSON.parse(payload);
    if (!Array.isArray(v)) return { jobIds: [] };
    return { jobIds: v.filter((x): x is string => typeof x === 'string') };
  } catch {
    return { jobIds: [] };
  }
}

/** The authenticated job ids, newest first. `[]` for anything unverifiable. */
export function verifyHistoryCookie(raw: string | undefined | null): string[] {
  return readHistoryCookie(raw).jobIds;
}

/** A job id as the API mints them — a v4-shaped UUID and nothing else. */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The newest job id in a signed history cookie, or `null`.
 *
 * The shape check is belt-and-braces over the signature: the id is
 * interpolated into an href, so anything that is not plainly a UUID is
 * dropped rather than escaped.
 */
export function latestJobId(raw: string | undefined | null): string | null {
  for (const id of verifyHistoryCookie(raw)) {
    if (JOB_ID.test(id)) return id;
  }
  return null;
}
