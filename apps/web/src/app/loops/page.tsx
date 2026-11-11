// /loops — the loop downloader, as its own product page.
//
// Jon, 2026-11-11: "loops downloader — available in top nav as 'download
// loops'. make it on a separate product page. only do the processing work to
// create loops when the user asks for the loops to be created." And: "make
// primary stem-loops product page the chords / play along / sliders."
//
// So /jobs/[id] stays the primary product (the player) and this is the
// secondary one. It takes a song you have ALREADY separated, and cuts loops out
// of it only when you press the button. Nothing is fetched, decoded or encoded
// before then — see LoopsView and lib/loops/plan.ts, which exists so the idle
// state can be drawn from arithmetic alone.
//
// SIGN-IN IS REQUIRED, for the same reason and by the same pattern as
// app/jobs/[id]/page.tsx: `await getUser()` then `redirect('/login?return_to=…')`,
// which is the one authenticated-page pattern in this repo (see also
// app/account/page.tsx and app/trial/page.tsx). That gate is why this file is a
// Server Component and the body lives in ./LoopsView — `getUser()` reads
// cookies, which a client component cannot do.
//
// `force-dynamic` because the gate reads the session cookie on every request;
// the same line appears for the same reason on /account, /trial and /jobs/[id].

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import LoopsView from './LoopsView';
// The page's stylesheet is imported HERE rather than inside LoopsView so that
// the client component's module graph is TypeScript only. test/loops-page.test.mjs
// compiles that graph with `tsc` and runs it under node; a `.css` specifier in it
// would be handed to the transpiler and imported as JavaScript. Next bundles a
// global stylesheet imported from a page exactly as it does one imported from a
// component, so nothing about what ships changes.
import '@/styles/loops-page.css';

export const metadata: Metadata = { title: 'Download loops', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function LoopsPage() {
  const user = await getUser();
  if (!user) redirect(`/login?return_to=${encodeURIComponent('/loops')}`);

  return <LoopsView />;
}
