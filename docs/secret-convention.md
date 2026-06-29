# Secret Convention

All secrets are **server-side only**. No secret is ever:
- Requested from the user
- Stored in the browser (no `NEXT_PUBLIC_` prefix on any secret)
- Logged in plain text
- Committed to git (`.env` is gitignored)

## Provisioning

1. Copy `.env.example` → `.env` (never commit `.env`)
2. Generate app secrets:
   ```bash
   openssl rand -hex 32   # for IP_HASH_KEY
   openssl rand -hex 32   # for HISTORY_COOKIE_KEY
   ```
3. Store in platform secret stores: Vercel env vars / Fly.io secrets / Render env vars

## App-generated secrets (TSD §3.5)

| Secret | Purpose | How to generate |
|---|---|---|
| `IP_HASH_KEY` | Keyed HMAC-SHA256 for IP hashing (rate-limit) | `openssl rand -hex 32` |
| `HISTORY_COOKIE_KEY` | HMAC-SHA256 signing key for anonymous history cookie | `openssl rand -hex 32` |

These are never exposed to users. They are server-side secrets provisioned at deploy time.

## Runtime rules

- Worker reads all secrets from environment variables only
- API routes read secrets from `process.env` (Next.js server-side only)
- Browser bundle must never contain a secret
- `NEXT_PUBLIC_` prefix is reserved for non-secret public config only

## Redaction (TSD §6.2 / T19)

- `worker/logger.py` redacts token/cookie patterns from all log `detail` before writing
- Structured logs are scrubbed before sending to Better Stack
- Pattern: anything matching `(cookie|token|bearer|session)[=:]\S+` → `[REDACTED]`
- Stderr is truncated to 500 bytes and redacted before persisting in `job_events.detail`
