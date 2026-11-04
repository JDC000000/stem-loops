import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/supabase';
import DeleteAccountForm from '@/components/DeleteAccountForm';

export const metadata: Metadata = { title: 'Delete account' };
export const dynamic = 'force-dynamic';

export default async function DeleteAccountPage() {
  // Auth is enforced per-route (middleware only refreshes cookies).
  const user = await getUser();
  if (!user) redirect('/login?return_to=/account/delete');

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 560, margin: '0 auto', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--text-primary)' }}>Delete account</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        This permanently deletes your stem-loops account. It cannot be undone.
      </p>
      <p style={{ color: 'var(--text-primary)', marginBottom: 4 }}>What will be deleted:</p>
      <ul style={{ color: 'var(--text-secondary)', marginTop: 0, paddingLeft: 20, lineHeight: 1.6 }}>
        <li>Your sign-in account (email, password and linked Google login)</li>
        <li>Your usage history and job history</li>
        <li>Your remaining credit balance and credit purchase records. Unused credits are not refunded.</li>
        <li>Any active subscription, which is cancelled immediately</li>
      </ul>
      <DeleteAccountForm email={user.email} />
      <p style={{ marginTop: 16, fontSize: 14 }}>
        <a href="/account" style={{ color: 'var(--text-muted)' }}>Cancel and go back</a>
      </p>
    </main>
  );
}
