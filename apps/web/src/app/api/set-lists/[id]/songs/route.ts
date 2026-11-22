// POST   /api/set-lists/:id/songs {job_id}              add a song (201 added, 200 already in it).
// DELETE /api/set-lists/:id/songs {item_id} | {job_id}  take one out (the song itself stays).
// PUT    /api/set-lists/:id/songs {order: [item_id…]}   reorder: the whole list, atomically.
//
// A song may be added when it is the caller's own job OR a demo song (is_demo). Another
// user's ordinary job is "not found" (404), exactly like a job that does not exist.
// The Demo set (`demo`) is read-only: every write here is 405.
//
// SECURITY: same-origin guard FIRST, then getUser(); every statement is owner-scoped
// (lib/set-lists-server.ts). A list that is not the caller's is 404.
//
// Errors: 400 INVALID_BODY · 401 AUTH_REQUIRED · 403 BAD_ORIGIN · 404 NOT_FOUND /
//         JOB_NOT_FOUND · 405 DEMO_SET_READ_ONLY · 409 SET_LIST_FULL / STALE_ORDER ·
//         500 INTERNAL_ERROR
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getUser } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { DEMO_SET_ID, MAX_SET_LIST_SONGS, isUuid } from '@/lib/set-lists';
import { addSongToSetList, removeSongFromSetList, reorderSetList } from '@/lib/set-lists-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export type AddSongResponse = { item_id: string; added: boolean };

type Ctx = { params: { id: string } };

const fail = (status: number, error_code: string, message: string) =>
  NextResponse.json({ error_code, message }, { status, headers: NO_STORE });
const notFound = () => fail(404, 'NOT_FOUND', 'Set list not found.');

/** The guard, the session and the list id, in that order, for every write here. */
async function preamble(req: NextRequest, params: Ctx['params']) {
  const refusal = crossOriginRefusal(req);
  if (refusal) return { res: fail(403, BAD_ORIGIN, refusal) } as const;
  const user = await getUser();
  if (!user) return { res: fail(401, 'AUTH_REQUIRED', 'Sign in to change your set lists.') } as const;
  if (params?.id === DEMO_SET_ID) return { res: fail(405, 'DEMO_SET_READ_ONLY', 'The Demo set can’t be changed.') } as const;
  if (!isUuid(params?.id)) return { res: notFound() } as const;
  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return { res: fail(400, 'INVALID_BODY', 'Body must be JSON.') } as const;
  }
  return { userId: user.user_id, listId: params.id, body } as const;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const p = await preamble(req, params);
    if ('res' in p) return p.res;
    if (!isUuid(p.body.job_id)) return fail(400, 'INVALID_BODY', 'Say which song to add.');
    const r = await addSongToSetList(p.userId, p.listId, p.body.job_id);
    if (!r.ok) {
      if (r.reason === 'not_found') return notFound();
      if (r.reason === 'job_not_found') return fail(404, 'JOB_NOT_FOUND', 'Song not found.');
      return fail(409, 'SET_LIST_FULL', `A set list holds up to ${MAX_SET_LIST_SONGS} songs.`);
    }
    const out: AddSongResponse = { item_id: r.item_id, added: r.added };
    return NextResponse.json(out, { status: r.added ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('POST /api/set-lists/:id/songs error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not add that song. Please try again.');
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const p = await preamble(req, params);
    if ('res' in p) return p.res;
    const by = isUuid(p.body.item_id)
      ? { itemId: p.body.item_id }
      : isUuid(p.body.job_id)
        ? { jobId: p.body.job_id }
        : null;
    if (!by) return fail(400, 'INVALID_BODY', 'Say which song to take out.');
    const r = await removeSongFromSetList(p.userId, p.listId, by);
    if (!r.ok) return notFound();
    return NextResponse.json({ removed: r.removed }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('DELETE /api/set-lists/:id/songs error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not take that song out. Please try again.');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const p = await preamble(req, params);
    if ('res' in p) return p.res;
    const order = p.body.order;
    if (!Array.isArray(order) || order.length > MAX_SET_LIST_SONGS || !order.every(isUuid)) {
      return fail(400, 'INVALID_BODY', 'Send the new order as a list of item ids.');
    }
    const r = await reorderSetList(p.userId, p.listId, order as string[]);
    if (!r.ok) {
      return r.reason === 'not_found'
        ? notFound()
        : fail(409, 'STALE_ORDER', 'This list changed in another tab. Reload it and try again.');
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('PUT /api/set-lists/:id/songs error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not reorder that list. Please try again.');
  }
}
