// Shared password validation for /account/reset-password flows.
//
// Keep the client and server validators identical so an attacker can't
// bypass the rules by hitting the API directly. These rules are intentionally
// lightweight — Supabase enforces its own (configurable) password policy on
// the server too; we don't want to overgate here and lock out passwords that
// Supabase itself would accept. Think of these as "minimum table stakes":
//
//   • ≥ 10 characters (above Supabase's default 6, below "annoying")
//   • at least one letter AND at least one digit
//   • no leading/trailing whitespace (catches copy-paste accidents)
//
// Returns `null` on success or a short user-facing error string. The string
// is rendered inline on the form — never passed to the server unchanged.

export const PASSWORD_MIN_LENGTH = 10;

export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter a password.';
  if (raw.length === 0) return 'Enter a password.';
  if (raw !== raw.trim()) return 'Password cannot start or end with a space.';
  if (raw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[A-Za-z]/.test(raw)) return 'Password must include a letter.';
  if (!/[0-9]/.test(raw)) return 'Password must include a digit.';
  return null;
}

// Basic email shape check — same philosophy as above: good enough to catch
// typos and empty submits, not strict enough to reject uncommon-but-valid
// addresses. Final validation is Supabase's job.
export function validateEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Enter your email.';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Enter your email.';
  if (trimmed.length > 254) return 'That email is too long.';
  // Literal "x@y" with a dot in the domain — intentionally permissive.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Enter a valid email address.';
  }
  return null;
}
