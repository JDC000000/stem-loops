import PgBoss from 'pg-boss';

// pg-boss (Node/web layer) owns enqueue, retry and scheduling. The Python worker
// consumes jobs from the `jobs` table via FOR UPDATE SKIP LOCKED (Gate 0 S2 decision).
let boss: PgBoss | null = null;

export const JOB_QUEUE = 'stem-loops-jobs';

export async function getQueue(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      max: 3, // stay within Supabase free-tier connection limit
    });
    await boss.start();
    await boss.createQueue(JOB_QUEUE);
  }
  return boss;
}

export async function enqueueJob(jobId: string): Promise<void> {
  const q = await getQueue();
  await q.send(JOB_QUEUE, { jobId }, { retryLimit: 1, expireInHours: 1 });
}
