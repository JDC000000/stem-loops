import type { Metadata } from 'next';
import LoginForm from '@/components/LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage({ searchParams }: { searchParams: { return_to?: string; error?: string } }) {
  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px', maxWidth: 400, margin: '0 auto', boxSizing: 'border-box' }}>
      <LoginForm returnTo={searchParams.return_to} initialError={searchParams.error} />
    </main>
  );
}
