// GET  /api/set-lists         the caller's set lists (#322), most recently changed first.
//      ?job=<uuid>            also says, per list, whether that song is in it (the player's
//                             "Add to set list…" checklist).
// POST /api/set-lists {name} create a list. 201 { list }.
//
// Free, Pro and Studio alike: no plan gate (US AC 1.9, 5.6, 5.7).
//
// SECURITY: owner-scoped from getUser() (lib/set-lists-server.ts: every statement filters
// `user_id = <session user>`). POST runs the same-origin guard FIRST (CSRF; lib/same-origin).
// Signed out: 401. Responses are per-user: private, no-store.
//
// Errors: 400 INVALID_NAME / INVALID_BODY · 401 AUTH_REQUIRED · 403 BAD_ORIGIN ·
//         409 NAME_TAKEN · 409 SET_LIST_LIMIT · 500 INTERNAL_ERROR
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getUser } from '@/lib/auth/supabase';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { MAX_SET_LISTS, checkSetListName, isUuid, type SetListSummary } from '@/lib/set-lists';
import { createSetList, listSetLists } from '@/lib/set-lists-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export type SetListsResponse = { lists: SetListSummary[]; max_lists: number };
export type CreateSetListResponse = { list: SetListSummary };

const fail = (status: number, error_code: string, message: string) =>
  NextResponse.json({ error_code, message }, { status, headers: NO_STORE });

export async function GET(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to see your set lists.');
    const job = req.nextUrl?.searchParams?.get('job') ?? null;
    const lists = await listSetLists(user.user_id, isUuid(job) ? job : null);
    const body: SetListsResponse = { lists, max_lists: MAX_SET_LISTS };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('GET /api/set-lists error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'Your set lists are temporarily unavailable.');
  }
}

export async function POST(req: NextRequest) {
  const refusal = crossOriginRefusal(req);
  if (refusal) return fail(403, BAD_ORIGIN, refusal);
  try {
    const user = await getUser();
    if (!user) return fail(401, 'AUTH_REQUIRED', 'Sign in to make a set list.');
    let body: { name?: unknown };
    try {
      body = (await req.json()) as { name?: unknown };
    } catch {
      return fail(400, 'INVALID_BODY', 'Body must be JSON.');
    }
    const name = checkSetListName(body?.name);
    if (!name.ok) return fail(400, 'INVALID_NAME', name.message);
    const r = await createSetList(user.user_id, name.name);
    if (!r.ok) {
      return r.reason === 'limit'
        ? fail(409, 'SET_LIST_LIMIT', `You can have up to ${MAX_SET_LISTS} set lists. Delete one to make room.`)
        : fail(409, 'NAME_TAKEN', 'You already have a set list with that name.');
    }
    const out: CreateSetListResponse = { list: r.list };
    return NextResponse.json(out, { status: 201, headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err);
    console.error('POST /api/set-lists error:', err instanceof Error ? err.message : 'unknown');
    return fail(500, 'INTERNAL_ERROR', 'We could not make that set list. Please try again.');
  }
}
