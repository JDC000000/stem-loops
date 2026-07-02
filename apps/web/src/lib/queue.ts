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
  // Operator non-negotiable (security review BLOCKER #4): max 3 attempts with
  // exponential backoff (was retryLimit:1, no backoff).
  await q.send(JOB_QUEUE, { jobId }, { retryLimit: 3, retryBackoff: true, expireInHours: 1 });
}
