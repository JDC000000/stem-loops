// Magic-link sign-in for EXISTING users only.
//
// `shouldCreateUser: false` stops signInWithOtp from creating accounts, which
// would bypass the hCaptcha gate on /api/auth/signup. Supabase answers an
// unknown address with an `otp_disabled` / "Signups not allowed for otp" error.
// We swallow it into the SAME message as success, matching the reset-password
// flow's anti-enumeration policy, so this form cannot be used to probe which
// addresses are registered.

export const MAGIC_LINK_SENT = 'If an account exists for that address, a sign-in link is on its way.';

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
      return MAGIC_LINK_SENT;
    }
    throw error;
  }
  return MAGIC_LINK_SENT;
}
