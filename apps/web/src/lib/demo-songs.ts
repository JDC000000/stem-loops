// SERVER ONLY. Finds the demo songs (is_demo rows, migration 040) for the demo route, the
// player page's signed-out gate and GET /api/demos. Imported only by server components
// and route handlers; it reads through the server's own `db` pool, never the browser.
//
// SCOPE: every query here carries `is_demo = true`, so nothing in this module can read or
// reveal an ordinary job, and every query is a read (no write on GET). It returns only
// what the player and the home poster show: id, title, BPM, key. Never user_id.
import { db } from '@/lib/db';
import { JOB_RETAINED_UNTIL_SQL } from '@/lib/retention';
import { DEMO_ARTIST, DEMO_SONGS, demoBySlug, demoForJobId } from '@/lib/demo-catalog';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoJob {
  readonly id: string;
  /** The catalog slug when the row is one of the three catalogued songs; else null. */
  readonly slug: string | null;
  readonly title: string;
  readonly artist: string;
  readonly bpm: number | null;
  readonly musical_key: string | null;
}

interface Row {
  id: string;
  title: string | null;
  bpm: number | string | null;
  musical_key: string | null;
}

function toDemoJob(r: Row): DemoJob {
  const entry = demoForJobId(r.id);
  const bpm = r.bpm === null || r.bpm === undefined ? null : Number(r.bpm);
  return {
    id: r.id,
    slug: entry?.slug ?? null,
    title: entry?.title ?? (r.title?.trim() || 'Demo song'),
    artist: DEMO_ARTIST,
    bpm: Number.isFinite(bpm) ? bpm : null,
    musical_key: r.musical_key ?? null,
  };
}

/**
 * How long one server instance reuses the demo list (review S2). /demo/<slug> and
 * GET /api/demos are public and dynamic; without this every request was a scan of `jobs`.
 * A demo flag change shows up within this window. A failed read is never cached.
 */
export const DEMO_LIST_TTL_MS = 60_000;
let cached: { at: number; jobs: Promise<DemoJob[]> } | null = null;

/** Forget the cached list (tests; and nothing else needs it). */
export function clearDemoJobsCache(): void {
  cached = null;
}

/**
 * Every playable demo song: done and retained, catalogued songs first in catalog order,
 * then any other demo row (oldest first). One small read per DEMO_LIST_TTL_MS per server
 * instance; no write.
 */
export async function listDemoJobs(now: number = Date.now()): Promise<DemoJob[]> {
  if (cached && now - cached.at < DEMO_LIST_TTL_MS) return cached.jobs;
  const jobs = readDemoJobs();
  cached = { at: now, jobs };
  jobs.catch(() => {
    if (cached?.jobs === jobs) cached = null;
  });
  return jobs;
}

async function readDemoJobs(): Promise<DemoJob[]> {
  const res = await db.query<Row>(
    `SELECT id::text AS id, title, bpm, musical_key
       FROM jobs
      WHERE is_demo = true AND status = 'done' AND ${JOB_RETAINED_UNTIL_SQL} > now()
      ORDER BY created_at ASC`,
  );
  const jobs = res.rows.map(toDemoJob);
  const rank = (j: DemoJob) => {
    const i = DEMO_SONGS.findIndex((d) => d.slug === j.slug);
    return i === -1 ? DEMO_SONGS.length : i;
  };
  return jobs.map((j, i) => ({ j, i })).sort((a, b) => rank(a.j) - rank(b.j) || a.i - b.i).map(({ j }) => j);
}

/**
 * The demo song a /demo/<slug> URL names: a catalog slug, or a demo job's own id (so a
 * demo that is not in the catalog — a re-processed song, a local test stack — is still
 * reachable). Returns null for anything that is not a playable demo row.
 */
export async function resolveDemo(slugOrId: string): Promise<DemoJob | null> {
  const key = slugOrId.toLowerCase();
  // Review S2: a key that can never match costs nothing — no database call. Only a catalog
  // slug or a well-formed UUID goes on to the (cached) demo list.
  if (!demoBySlug(key) && !UUID_RE.test(key)) return null;
  const demos = await listDemoJobs();
  if (UUID_RE.test(key)) return demos.find((d) => d.id === key) ?? null;
  return demos.find((d) => d.slug === key) ?? null;
}

/** True only for a retained `is_demo` row with this id. The player page's signed-out gate. */
export async function isDemoJob(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const res = await db.query(
    `SELECT 1 FROM jobs WHERE id = $1 AND is_demo = true AND ${JOB_RETAINED_UNTIL_SQL} > now()`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}
