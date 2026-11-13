import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import { db } from '@/lib/db';
import { serverGet, type CreditsBalance, type Entitlements } from '@/lib/billing/server-fetch';
import BillingButton from '@/components/BillingButton';
import { jobLabel } from '@/lib/job-label';

export const metadata: Metadata = { title: 'Account', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

type JobRow = {
  id: string;
  title: string | null;
  original_filename: string | null;
  youtube_url: string | null;
  status: string;
  created_at: string;
};

async function recentJobs(userId: string): Promise<JobRow[] | null> {
  try {
    const r = await db.query(
      `SELECT id, title, original_filename, youtube_url, status, created_at FROM public.jobs
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId],
    );
    return r.rows as JobRow[];
  } catch {
    return null;
  }
}

const fmt = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const section = {
  border: '1px solid var(--border-default, #333)', borderRadius: 12, padding: 16,
  background: 'var(--bg-card, #151515)', marginTop: 16,
};
const h2 = { margin: '0 0 8px', fontSize: 18, color: 'var(--text-primary)' };
const muted = { color: 'var(--text-muted)', fontSize: 14 };

export default async function AccountPage() {
  const user = await getUser();
  if (!user) redirect('/login?return_to=/account');

  const [ent, bal, jobs] = await Promise.all([
    serverGet<Entitlements>('/api/entitlements'),
    serverGet<CreditsBalance>('/api/billing/credits/balance'),
    recentJobs(user.user_id),
  ]);

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 720, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Account</h1>
      <p style={{ ...muted, overflowWrap: 'anywhere' }}>{user.display_name ? `${user.display_name} · ` : ''}{user.email}</p>

      <section style={section} aria-label="Plan">
        <h2 style={h2}>Plan</h2>
        {ent.ok ? (
          <>
            <p style={{ margin: '0 0 4px', color: 'var(--text-primary)' }}>
              <strong>{ent.data.plan_code}</strong>
            </p>
            {/* Two independent fixes meet on this line, and both are needed.

                LABEL (#233): "Monthly allowance used", not "Tracks this month".
                jobs_used counts units of the MONTHLY ALLOWANCE spent, and since
                #233 a credit-funded upload no longer spends one -- so for a
                credit buyer this numerator stays 0 however many tracks they
                convert. Called "Tracks this month" it would lie to exactly the
                users who paid. Credits spent are shown in the Credits section.
                NOT renamed on the wire: jobs_used is a public field of
                GET /api/entitlements. A true per-month track count needs its
                own COUNT(*) over jobs -- scoped in #233's PR body.

                NO "(unlimited)" BRANCH (#210): migration 034 gives every plan a
                real monthly number (5 / 50 / 150), so no plan reaches the
                100000 sentinel and that branch could only ever lie. Always
                show used / quota, which is what checkMonthlyQuota() enforces. */}
            <p style={muted}>
              Renews / ends: {fmt(ent.data.period_end)} · Monthly allowance used: {ent.data.jobs_used ?? 0}
              {` / ${ent.data.jobs_quota ?? '—'}`}
            </p>
          </>
        ) : (
          <p style={muted}>Plan details are temporarily unavailable.</p>
        )}
        {/* Portal is only useful for paid plans; free-tier users have no
            customers_billing row and the portal call would 400. Show the
            manage button only when the user is on a paid plan. */}
        {ent.ok && ent.data.plan_code !== 'free' && (
          <div style={{ maxWidth: 260, marginTop: 8 }}>
            <BillingButton label="Manage subscription" endpoint="/api/billing/portal" returnTo="/account" primary={false} />
          </div>
        )}
        <p style={{ ...muted, marginTop: 8 }}><a href="/pricing">See plans and credit packs</a></p>
      </section>

      <section style={section} aria-label="Credits">
        <h2 style={h2}>Credits</h2>
        {bal.ok ? (
          <>
            <p style={{ margin: '0 0 8px', color: 'var(--text-primary)' }}>
              <strong>{bal.data.credits_remaining}</strong> remaining
            </p>
            {bal.data.purchases?.length ? (
              <ul style={{ margin: 0, paddingLeft: 18, ...muted }}>
                {bal.data.purchases.slice(0, 5).map((p, i) => (
                  <li key={i}>{p.credits_granted ?? '?'} credits · {fmt(p.created_at)}</li>
                ))}
              </ul>
            ) : (
              <p style={muted}>No purchases yet.</p>
            )}
          </>
        ) : (
          <p style={muted}>Credit balance is temporarily unavailable.</p>
        )}
      </section>

      <section style={section} aria-label="Recent jobs">
        <h2 style={h2}>Recent jobs</h2>
        {jobs === null ? (
          <p style={muted}>Jobs are temporarily unavailable.</p>
        ) : jobs.length === 0 ? (
          <p style={muted}>No jobs yet. <a href="/">Extract some loops</a></p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map((j) => (
              <li key={j.id}>
                <a href={`/jobs/${j.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minHeight: 44, alignItems: 'center', textDecoration: 'none', color: 'var(--text-primary)' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{jobLabel(j)}</span>
                  <span style={{ ...muted, whiteSpace: 'nowrap' }}>{j.status} · {fmt(j.created_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ marginTop: 24, fontSize: 14 }}>
        <a href="/account/delete" style={{ color: 'var(--status-failed, #f66)' }}>Delete account</a>
      </p>
    </main>
  );
}
