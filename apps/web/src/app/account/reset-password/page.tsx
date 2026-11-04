// /account/reset-password — two states driven by whether the viewer has
// a Supabase recovery session cookie:
//
//   1. UNAUTHENTICATED  → "Request reset" form (email in, success message).
//   2. AUTHENTICATED    → "Set new password" form (new password + confirm).
//
// The link in the recovery email points at `/auth/callback?type=recovery&
// next=/account/reset-password`; the callback exchanges the code for a
// session cookie and forwards here. By the time this page renders in the
// authenticated branch, `getUser()` returns a verified user.
//
// We keep everything in a single page so bookmarking /account/reset-password
// works whether the user is signed in or not — they always see something
// actionable instead of a redirect to /login (which would strand them if
// the recovery session was what brought them here).

import type { Metadata } from 'next';
import { getUser } from '@/lib/auth/supabase';
import ResetPasswordRequestForm from '@/components/ResetPasswordRequestForm';
import ResetPasswordSetForm from '@/components/ResetPasswordSetForm';

export const metadata: Metadata = { title: 'Reset password' };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage() {
  const user = await getUser();
  return (
    <main
      style={{
        minHeight: '100dvh',
        padding: '24px 16px',
        maxWidth: 400,
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
    >
      {user ? <ResetPasswordSetForm /> : <ResetPasswordRequestForm />}
    </main>
  );
}
