import PgBoss from 'pg-boss';
import { sslFor } from '@/lib/db';

// pg-boss (Node/web layer) owns enqueue, retry and scheduling. The Python worker
// consumes jobs from the `jobs` table via FOR UPDATE SKIP LOCKED (Gate 0 S2 decision).
let boss: PgBoss | null = null;

export const JOB_QUEUE = 'stem-loops-jobs';

export async function getQueue(): Promise<PgBoss> {
  if (!boss) {
    const conn = process.env.DATABASE_URL!;
    boss = new PgBoss({
      connectionString: conn,
      max: 3, // stay within Supabase free-tier connection limit
      ssl: sslFor(conn), // Supabase pooler: TLS without chain verification (see db.ts)
    });
    await boss.start();
    await boss.createQueue(JOB_QUEUE);
  }
  return boss;
}

export async function enqueueJob(jobId: string): Promise<void> {
  const q = await getQueue();
  // NOTE (security re-verification BLOCKER #4): the Python worker consumes jobs by
  // polling the `jobs` table via FOR UPDATE SKIP LOCKED — it never calls boss.work(),
  // so pg-boss's retry engine is NOT in the consume path. retryLimit/retryBackoff here
  // would be pure config-theater (no-ops). The real bounded-attempts + exponential-
  // backoff retry lives in the worker's reaper (apps/worker/src/worker/reaper.py). We
  // keep only expireInHours so the durable enqueue record self-expires.
  await q.send(JOB_QUEUE, { jobId }, { expireInHours: 1 });
}
