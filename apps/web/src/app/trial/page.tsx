// /trial — V3 Phase 1a (TSD §1.6, V3-C10).
//
// Three states, server-rendered from readTrial():
//   • no grant yet            → "Start trial" button (calls /api/users/me/trial/grant)
//   • active grant with songs → "N songs left · expires DATE"
//   • expired OR exhausted    → "Trial used / expired" + link to /pricing

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import { readTrial, TRIAL_SONG_CAP } from '@/lib/trial';
import StartTrialButton from './StartTrialButton';

export const metadata: Metadata = { title: 'Free trial', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const section = {
  border: '1px solid var(--border-default, #333)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--bg-card, #151515)',
  marginTop: 16,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 12,
};
const h2 = { margin: 0, fontSize: 22, color: 'var(--text-primary)' };
const muted = { color: 'var(--text-muted)', fontSize: 14 };
const linkBtn = {
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 16px',
  borderRadius: 8,
  border: '1px solid var(--border-default, #444)',
  textDecoration: 'none',
  color: 'var(--text-primary)',
};

const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export default async function TrialPage() {
  const user = await getUser();
  if (!user) redirect('/login?return_to=/trial');

  // readTrial never throws on "no row" — a missing row is state=not-present.
  let state: Awaited<ReturnType<typeof readTrial>> | null = null;
  let degraded = false;
  try {
    state = await readTrial(user.user_id);
  } catch {
    degraded = true;
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        padding: '24px 16px',
        maxWidth: 640,
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Free trial</h1>
      <p style={muted}>
        {TRIAL_SONG_CAP} songs free with signup. No card required. Expires 7 days after you start.
      </p>

      {degraded && (
        <p role="status" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Trial status is temporarily unavailable — try again shortly.
        </p>
      )}

      {!degraded && state && state.present === false && (
        <section style={section} aria-label="Start trial">
          <h2 style={h2}>Start your trial</h2>
          <p style={muted}>
            You have no active trial yet. Starting one unlocks {TRIAL_SONG_CAP} songs you can process
            for free — anything beyond that uses the free plan or a paid upgrade.
          </p>
          <StartTrialButton />
        </section>
      )}

      {!degraded && state && state.present === true && !state.expired && state.songs_remaining > 0 && (
        <section style={section} aria-label="Trial active">
          <h2 style={h2}>
            {state.songs_remaining} {state.songs_remaining === 1 ? 'song' : 'songs'} left
          </h2>
          <p style={muted}>Trial expires {fmtDate(state.expires_at)} UTC.</p>
          <a href="/" style={linkBtn}>
            Process a song
          </a>
        </section>
      )}

      {!degraded && state && state.present === true && (state.expired || state.songs_remaining === 0) && (
        <section style={section} aria-label="Trial used or expired">
          <h2 style={h2}>Trial used / expired</h2>
          <p style={muted}>
            {state.expired
              ? `Your trial expired on ${fmtDate(state.expires_at)}.`
              : `You have used all ${TRIAL_SONG_CAP} trial songs.`}{' '}
            Pick a plan or buy credits to keep going.
          </p>
          <a
            href="/pricing"
            style={{
              ...linkBtn,
              background: 'var(--btn-primary-bg, var(--accent))',
              color: 'var(--btn-primary-text, #000)',
              border: 'none',
              fontWeight: 600,
            }}
          >
            See pricing
          </a>
        </section>
      )}
    </main>
  );
}
