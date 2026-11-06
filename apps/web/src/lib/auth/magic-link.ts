// Magic-link sign-in for EXISTING users only.
//
// `shouldCreateUser: false` stops signInWithOtp from creating accounts, which
// would bypass the hCaptcha gate on /api/auth/signup. Supabase answers an
// unknown address with an `otp_disabled` / "Signups not allowed for otp" error;
// we turn that into an instruction instead of surfacing the raw string.

export const MAGIC_LINK_SENT = 'Check your email for a one-time login link.';
export const MAGIC_LINK_NO_ACCOUNT =
  'No account found for that email. Use "Create account" to sign up first; one-time links only work for existing accounts.';

interface OtpClient {
  auth: {
    signInWithOtp(args: {
      email: string;
      options: { emailRedirectTo: string; shouldCreateUser: boolean };
    }): Promise<{ error: { message?: string; code?: string } | null }>;
  };
}

export async function sendMagicLink(
  client: OtpClient,
  email: string,
  emailRedirectTo: string,
): Promise<string> {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo, shouldCreateUser: false },
  });
  if (error) {
    if (error.code === 'otp_disabled' || /signups? not allowed/i.test(error.message ?? '')) {
      return MAGIC_LINK_NO_ACCOUNT;
    }
    throw error;
  }
  return MAGIC_LINK_SENT;
}
