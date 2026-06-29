// S2: validate the pg-boss polling pattern end-to-end.
//
// Enqueues 5 healthy jobs + 1 poison job, confirms the 5 drain, the poison job
// fails in ISOLATION (does not block the queue), and the connection pool stays
// within Supabase free-tier limits (<=15). Exits 0 on success.
//
// Run: DATABASE_URL=... node apps/worker/spikes/s2_pgboss/validate.js
import PgBoss from 'pg-boss';

const POOL_MAX = 3;
const QUEUE = 's2-test';
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, max: POOL_MAX });

let completed = 0;
let failed = 0;

boss.on('error', (err) => console.error('[pg-boss error]', err.message));

await boss.start();
await boss.createQueue(QUEUE);

// pg-boss v10 hands the worker an array of jobs; older versions a single job.
// Normalise so the spike is robust across versions.
const handler = async (payload) => {
  const jobs = Array.isArray(payload) ? payload : [payload];
  for (const job of jobs) {
    if (job.data?.poison) {
      failed++;
      throw new Error('poison job intentional failure');
    }
    completed++;
    console.log(`completed job ${job.data?.idx}`);
  }
};

await boss.work(QUEUE, { batchSize: 1, pollingIntervalSeconds: 1 }, handler);

// Enqueue 5 healthy + 1 poison (retryLimit 0 → poison fails once, no retry storm).
for (let i = 0; i < 5; i++) await boss.send(QUEUE, { idx: i }, { retryLimit: 0 });
await boss.send(QUEUE, { poison: true }, { retryLimit: 0 });

// Let the worker drain for up to 30s, polling queue size.
const deadline = Date.now() + 30_000;
let queued = await boss.getQueueSize(QUEUE);
while (Date.now() < deadline && (completed < 5 || queued > 0)) {
  await new Promise((r) => setTimeout(r, 1000));
  queued = await boss.getQueueSize(QUEUE);
}

console.log(`completed=${completed} failed=${failed} queued=${queued} pool_max=${POOL_MAX}`);
await boss.stop({ graceful: true, timeout: 5000 });

const ok = completed === 5 && queued === 0 && failed >= 1;
console.log(ok ? 'S2 PASS: healthy jobs drained, poison isolated' : 'S2 FAIL');
process.exit(ok ? 0 : 1);
