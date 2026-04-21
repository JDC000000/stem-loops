/**
 * Upstash Redis client — used for job state, freemium IP counters, and the
 * job queue that the Python worker consumes from.
 *
 * Env vars:
 *   UPSTASH_REDIS_REST_URL     https://<id>.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN   full-access token
 *
 * For local dev without Redis set up, pointing both vars at a throwaway
 * Upstash free-tier database is the cleanest path — no need to spin up a
 * local redis server.
 */

import { Redis } from "@upstash/redis";

function env(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `Missing required env var: ${key}. ` +
        `Set it in .env.local for dev or in Railway for production.`,
    );
  }
  return v;
}

// Lazy singleton — only constructs on first use so importing this module
// doesn't throw at build time when the env vars legitimately aren't present
// (e.g. static analysis).
let _client: Redis | null = null;

export function redis(): Redis {
  if (!_client) {
    _client = new Redis({
      url: env("UPSTASH_REDIS_REST_URL"),
      token: env("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return _client;
}

// Key builders — all in one place so the schema is easy to audit.
export const keys = {
  job: (id: string) => `job:${id}`,
  ipCounter: (ip: string) => `ip:${ip}`,
  queue: () => "stem-loops:jobs",
};

// TTLs in seconds
export const TTL = {
  job: 60 * 60 * 48, // 48 hours — jobs live twice the 24hr download window
  ipCounter: 60 * 60 * 24 * 7, // 7 days — freemium reset rolling weekly
};
