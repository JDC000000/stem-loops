// GET    /api/set-lists/:id          one of the caller's lists, its items resolved (#322).
// PATCH  /api/set-lists/:id {name}   rename it.
// DELETE /api/set-lists/:id          delete it. Its items go with it; songs (jobs) never do.
//
// The Demo set is /api/set-lists/demo, a sibling STATIC route: Next routes every method on
// that path there (GET only; Next answers the rest 405), so this module never sees `demo`.
//
// SECURITY: owner-scoped from getUser(); a list that is not the caller's is 404, never 403
// (a 403 would confirm the id is real). Writes run the same-origin guard FIRST.
//
// Errors: 400 INVALID_NAME / INVALID_BODY · 401 AUTH_REQUIRED · 403 BAD_ORIGIN ·
//         404 NOT_FOUND · 409 NAME_TAKEN · 500 INTERNAL_ERROR
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getUser } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { checkSetListName, isUuid, type SetListDetail } from '@/lib/set-lists';
import { deleteSetList, getSetList, renameSetList } from '@/lib/set-lists-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export type SetListResponse = { list: SetListDetail };

type Ctx = { params: { id: string } };

const fail = (status: number, error_code: string, message: string) =>
  NextResponse.json({ error_code, message }, { status, headers: NO_STORE });
const notFound = () => fail(404, 'NOT_FOUND', 'Set list not found.');

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to see your set lists.');
    if (!isUuid(params?.id)) return notFound();
    const list = await getSetList(user.user_id, params.id);
    if (!list) return notFound();
    const body: SetListResponse = { list };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/set-lists/:id error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'This set list is temporarily unavailable.');
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const refusal = crossOriginRefusal(req);
  if (refusal) return fail(403, BAD_ORIGIN, refusal);
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to change your set lists.');
    if (!isUuid(params?.id)) return notFound();
    let body: { name?: unknown };
    try {
      body = (await req.json()) as { name?: unknown };
    } catch {
      return fail(400, 'INVALID_BODY', 'Body must be JSON.');
    }
    const name = checkSetListName(body?.name);
    if (!name.ok) return fail(400, 'INVALID_NAME', name.message);
    const r = await renameSetList(user.user_id, params.id, name.name);
    if (!r.ok) return r.reason === 'not_found' ? notFound() : fail(409, 'NAME_TAKEN', 'You already have a set list with that name.');
    return NextResponse.json({ ok: true, name: name.name }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('PATCH /api/set-lists/:id error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not rename that set list. Please try again.');
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const refusal = crossOriginRefusal(req);
  if (refusal) return fail(403, BAD_ORIGIN, refusal);
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to change your set lists.');
    if (!isUuid(params?.id)) return notFound();
    if (!(await deleteSetList(user.user_id, params.id))) return notFound();
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('DELETE /api/set-lists/:id error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not delete that set list. Please try again.');
  }
}
