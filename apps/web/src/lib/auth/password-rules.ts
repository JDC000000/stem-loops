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

/** The rule, as shown under every new-password field BEFORE anyone types (Slice 1b). Worded
 *  from the same constant validatePassword() enforces, so the hint and the check agree. */
export const PASSWORD_RULE_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`;

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

/** Sign-up only (Slice 1b; Jon, 2026-11-17): two real sign-ups bounced on `name!@gmail.com`. */
export const SIGNUP_EMAIL_CHAR_MSG =
  "Check your email address — it has a character most email providers don't accept.";

// Characters in the LOCAL part (before the @) that Gmail and most providers refuse, even
// though RFC 5322 allows several of them: whitespace and ! # $ % & * / = ? ^ ` { | } ~ " ( )
// , : ; < > [ \ ]. Letters (including non-ASCII), digits, . _ + - and ' are left alone so
// no ordinary address is turned away.
const LOCAL_PART_BAD_CHAR = /[\s!#$%&*/=?^`{|}~"(),:;<>[\]\\]/;

/**
 * The sign-up form's email check: validateEmail(), then a local-part check for characters
 * (and dot patterns: leading, trailing, consecutive) that most providers do not accept, so a
 * confirmation email is not sent to an address that will bounce. Used by the sign-up form and
 * POST /api/auth/signup only. Sign-in and password reset keep validateEmail() unchanged, so an
 * account that already exists is never locked out by the stricter rule.
 */
export function validateSignupEmail(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const at = trimmed.lastIndexOf('@');
    if (at > 0) {
      const local = trimmed.slice(0, at);
      if (
        LOCAL_PART_BAD_CHAR.test(local) ||
        local.startsWith('.') ||
        local.endsWith('.') ||
        local.includes('..')
      ) {
        return SIGNUP_EMAIL_CHAR_MSG;
      }
    }
  }
  return validateEmail(raw);
}
