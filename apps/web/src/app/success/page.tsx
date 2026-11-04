import type { Metadata } from 'next';
import { getUser } from '@/lib/auth/supabase';
import { serverGet, type CreditsBalance } from '@/lib/billing/server-fetch';

export const metadata: Metadata = { title: 'Thank you' };
export const dynamic = 'force-dynamic';

const PACKS = new Set(['20', '60', '180']);

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: { session_id?: string; credits?: string };
}) {
  const user = await getUser().catch(() => null);
  const credits = searchParams.credits && PACKS.has(searchParams.credits) ? searchParams.credits : null;
  const balance = user ? await serverGet<CreditsBalance>('/api/billing/credits/balance') : null;

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 560, margin: '0 auto', boxSizing: 'border-box' }}>
      {user ? (
        <>
          <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Thanks!</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            {credits
              ? `Your ${credits} credits are active.`
              : 'Your credits/subscription is active.'}
          </p>
          {balance?.ok ? (
            <p style={{ color: 'var(--text-primary)', fontSize: 18 }}>
              New balance: <strong>{balance.data.credits_remaining}</strong> credits
            </p>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              Your balance may take a moment to update. Check your account shortly.
            </p>
          )}
          <a href="/account" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 16px', borderRadius: 8, background: 'var(--btn-primary-bg, var(--accent))', color: 'var(--btn-primary-text, #000)', textDecoration: 'none', fontWeight: 600 }}>
            Go to your account
          </a>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Thanks!</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Sign in to see your purchase.</p>
          <a href="/login?return_to=/account" style={{ color: 'var(--accent)' }}>Sign in</a>
        </>
      )}
    </main>
  );
}
