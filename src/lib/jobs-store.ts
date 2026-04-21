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

  // Fire-and-forget the mock pipeline. Once the real Python worker is
  // deployed, we'll replace this with an LPUSH onto the queue:
  //   await redis().lpush(keys.queue(), JSON.stringify({ id, ...req }));
  void simulateJob(id);

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

/* -------------------------------------------------------------------------- */
/*  Mock pipeline simulator                                                   */
/*                                                                            */
/*  Kept until the Python worker is live. Each stage persists to Redis so     */
/*  the frontend's polling gets real progress updates even if the Next.js     */
/*  container restarts mid-simulation (the job will just sit at its last     */
/*  written state since the stage-advancement loop is in-process only).       */
/* -------------------------------------------------------------------------- */

async function simulateJob(id: string): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stages: Array<{
    status: Job["status"];
    stage: string;
    progress: number;
    ms: number;
  }> = [
    {
      status: "downloading",
      stage: "Downloading audio from YouTube",
      progress: 15,
      ms: 2000,
    },
    {
      status: "separating",
      stage: "Separating stems with Demucs",
      progress: 55,
      ms: 4000,
    },
    {
      status: "extracting",
      stage: "Extracting bar-aligned loops",
      progress: 85,
      ms: 2000,
    },
  ];

  for (const s of stages) {
    await wait(s.ms);
    const exists = await getJob(id);
    if (!exists) return; // Job was deleted / expired mid-run
    await updateJob(id, s);
  }

  await wait(800);
  const job = await getJob(id);
  if (!job) return;

  // Fabricate mock results so the UI can be demoed before the worker is live
  const mockBpm = 120;
  const mockResults = job.stems.map((stem) => ({
    stem,
    loops: Array.from({ length: 5 }, (_, i) => {
      const energyLabels = [
        "Quiet/Intro",
        "Low Energy",
        "Medium Energy",
        "High Energy",
        "Peak Energy",
      ];
      return {
        index: i + 1,
        filename: `mock_${stem}_${mockBpm}bpm_loop_${String(i + 1).padStart(2, "0")}.wav`,
        downloadUrl: "#",
        durationSec: (60 / mockBpm) * 4 * job.bars,
        bpm: mockBpm,
        energyLabel: energyLabels[i],
        startSec: 10 + i * 30,
        endSec: 10 + i * 30 + (60 / mockBpm) * 4 * job.bars,
      };
    }),
  }));

  await updateJob(id, {
    status: "done",
    progress: 100,
    stage: "Complete",
    title: "Mock YouTube Song",
    artist: "Demo Artist",
    bpm: mockBpm,
    results: mockResults,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
}
