# V3-U2: Anonymous → Authed Job Attribution (claim-jobs)

**Authoritative TSD:** §2.2 in `TSD-V3-DELTA.md` on the Claude Projects "Stem Loops - Project 2026" workspace (`04-tsd-and-workplan/TSD-V3-DELTA.md`).

**Why this file exists:** The canonical TSD is a living doc on the Projects workspace, not in this repo. This file mirrors the stable parts so reviewers and CI tests can cite them inline.

## Behavior (stable)

- Route: `POST /api/users/me/claim-jobs`
- Auth: required
- Body: `{ client_fingerprint: string }` — 8-128 chars, stored client-side in localStorage
- Response: `{ claimed_count: number, truncated: boolean }`
- Rate limit: 1 call per hour per user (recorded in `usage_events` with `kind='claim_jobs'`)
- Max claimed per call: 5000 rows. Beyond this, `truncated=true`; user retries after 1h window

## Attribution rules

1. Only jobs where `user_id IS NULL` are candidates (idempotent — already-attributed rows are untouched)
2. Must match on `client_fingerprint = $1`
3. IP-hash cohort: `client_ip_hash IN (SELECT DISTINCT client_ip_hash FROM jobs WHERE client_fingerprint = $1 LIMIT 50)` — self-referential, server-derived, not spoofable from request body
4. Cross-user isolation: `user_id IS NULL` filter prevents claiming another user's attributed jobs

## Known Phase 1b work

- **HMAC-sign client_fingerprint** (deferred from Phase 1a per Jon 2026-11-03): currently fingerprint is user-controlled; a signed-in attacker who learns another user's fingerprint AND shares one IP-hash cohort row can claim their anon jobs. Mitigated by 1-call/hr rate limit. Phase 1b: bind fingerprint to signup nonce via HMAC, verify on claim-jobs.

## Observability

New `usage_events.kind` values:
- `claim_jobs` — every call attempt (even failures), for rate limiting
- `claim_jobs_truncated` — when response has `truncated=true`, with `detail={count: <actual_matched>}`
