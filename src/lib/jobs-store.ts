/**
 * Job store backed by Upstash Redis.
 *
 * Keys used (all defined in redis.ts `keys`):
 *   job:<uuid>        JSON Job, 48hr TTL
 *   ip:<ip>           integer counter, 7-day TTL
 *   stem-loops:jobs   LIST, queue for the Python worker (LPUSH / BLPOP)
 *
 * Until the worker is deployed in step 3, we keep the in-process
 * `simulateJob` fake pipeline so the UI has something to poll against.
 * It writes straight to Redis so state survives container restarts.
 */

import { randomUUID } from "crypto";
import { Job, JobRequest } from "./types";
import { keys, redis, TTL } from "./redis";

export const FREE_LIMIT = 3;

/* -------------------------------------------------------------------------- */
/*  Freemium IP counter                                                       */
/* -------------------------------------------------------------------------- */

export async function getIpJobCount(ip: string): Promise<number> {
  const v = await redis().get<number>(keys.ipCounter(ip));
  return typeof v === "number" ? v : 0;
}

export async function incrementIpJobCount(ip: string): Promise<number> {
  const key = keys.ipCounter(ip);
  const next = await redis().incr(key);
  if (next === 1) {
    // Fresh key — set expiry so counters roll off after 7 days
    await redis().expire(key, TTL.ipCounter);
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/*  Job CRUD                                                                  */
/* -------------------------------------------------------------------------- */

export async function createJob(req: JobRequest): Promise<Job> {
  const id = randomUUID();
  const job: Job = {
    id,
    createdAt: new Date().toISOString(),
    status: "queued",
    progress: 0,
    stage: "Queued — waiting for a worker",
    url: req.url,
    bars: req.bars,
    stems: req.stems,
  };
  await writeJob(job);

  // Hand the job off to the Python worker via Redis list.
  // The worker pops from this key, runs the pipeline, and writes status
  // updates directly back to job:<id>.
  await redis().lpush(
    keys.queue(),
    JSON.stringify({
      id,
      url: req.url,
      stems: req.stems,
      bars: req.bars,
    }),
  );

  return job;
}

export async function getJob(id: string): Promise<Job | undefined> {
  const raw = await redis().get<Job | string>(keys.job(id));
  if (!raw) return undefined;
  // Upstash auto-parses JSON on the way out, but occasionally returns a
  // string in edge cases. Handle both.
  return typeof raw === "string" ? (JSON.parse(raw) as Job) : raw;
}

export async function updateJob(
  id: string,
  patch: Partial<Job>,
): Promise<Job | undefined> {
  const prev = await getJob(id);
  if (!prev) return undefined;
  const next: Job = { ...prev, ...patch };
  await writeJob(next);
  return next;
}

async function writeJob(job: Job): Promise<void> {
  await redis().set(keys.job(job.id), JSON.stringify(job), {
    ex: TTL.job,
  });
}

