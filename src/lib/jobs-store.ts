/**
 * In-memory job store — MVP stub.
 *
 * In production, swap this for:
 *   - Redis (Upstash) for queue + status tracking
 *   - Supabase Postgres for user history + freemium counter
 *   - Cloudflare R2 for loop WAV storage
 *
 * This module keeps the API routes working during local dev without any
 * external services. Jobs live in process memory and die on restart.
 */

import { Job, JobRequest } from "./types";
import { randomUUID } from "crypto";

const JOBS = new Map<string, Job>();

/** 3-free-songs counter keyed by IP. Real impl: Redis with 7-day TTL. */
const IP_COUNTERS = new Map<string, number>();

export const FREE_LIMIT = 3;

export function getIpJobCount(ip: string): number {
  return IP_COUNTERS.get(ip) ?? 0;
}

export function incrementIpJobCount(ip: string): number {
  const next = (IP_COUNTERS.get(ip) ?? 0) + 1;
  IP_COUNTERS.set(ip, next);
  return next;
}

export function createJob(req: JobRequest): Job {
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
  JOBS.set(id, job);
  // Kick off a fake pipeline so the UI has something to poll against in dev.
  // Remove this in production; the Python worker handles real jobs.
  void simulateJob(id);
  return job;
}

export function getJob(id: string): Job | undefined {
  return JOBS.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const prev = JOBS.get(id);
  if (!prev) return undefined;
  const next = { ...prev, ...patch };
  JOBS.set(id, next);
  return next;
}

/**
 * Dev-only fake pipeline. Advances a job through the stages with delays so
 * the frontend polling, progress bar, and results UI can be tested without
 * running Demucs.
 */
async function simulateJob(id: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stages: Array<{
    status: Job["status"];
    stage: string;
    progress: number;
    ms: number;
  }> = [
    { status: "downloading", stage: "Downloading audio from YouTube", progress: 15, ms: 2000 },
    { status: "separating", stage: "Separating stems with Demucs", progress: 55, ms: 4000 },
    { status: "extracting", stage: "Extracting bar-aligned loops", progress: 85, ms: 2000 },
  ];
  for (const s of stages) {
    await wait(s.ms);
    if (!JOBS.has(id)) return;
    updateJob(id, s);
  }
  await wait(800);
  const job = JOBS.get(id);
  if (!job) return;

  // Fabricate fake results so the UI can be built against something
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
        filename: `mock_${stem}_${mockBpm}bpm_loop_${String(i + 1).padStart(
          2,
          "0",
        )}.wav`,
        downloadUrl: "#",
        durationSec: (60 / mockBpm) * 4 * job.bars,
        bpm: mockBpm,
        energyLabel: energyLabels[i],
        startSec: 10 + i * 30,
        endSec: 10 + i * 30 + (60 / mockBpm) * 4 * job.bars,
      };
    }),
  }));

  updateJob(id, {
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
