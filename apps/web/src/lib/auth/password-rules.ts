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
 * The sign-up form's email check: validateEmail(), then a local-part AND domain check for characters
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
      const domain = trimmed.slice(at + 1);
      if (
        LOCAL_PART_BAD_CHAR.test(local) ||
        local.startsWith('.') ||
        local.endsWith('.') ||
        local.includes('..') ||
        // The DOMAIN too (review round 2, N-6): `a@gm!ail.com` is a typo that bounces just
        // like `name!@gmail.com`. None of these characters is legal in a host name, and a
        // domain cannot start or end with a dot or have two in a row, so no real address
        // is turned away.
        LOCAL_PART_BAD_CHAR.test(domain) ||
        domain.startsWith('.') ||
        domain.endsWith('.') ||
        domain.includes('..')
      ) {
        return SIGNUP_EMAIL_CHAR_MSG;
      }
    }
  }
  return validateEmail(raw);
}

// ─── "Did you mean …?" for common provider typos (QA A-09, 2026-11-18) ─────────
// `jon@gmial.com` created an account and a confirmation email that bounced (the
// bounce class behind QA-05). This is a WARNING, never a block: the sign-up form
// shows "Did you mean jon@gmail.com?" with a one-tap fix and still submits what
// was typed. Only exact, known misspellings of the big mail providers are
// corrected, so no real domain is ever second-guessed (email.com, ymail.com,
// hotmail.co.uk and friends are real and are left alone).
const TYPO_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  'gmail.com': [
    'gmial.com', 'gmai.com', 'gmal.com', 'gmali.com', 'gmaill.com', 'gamil.com', 'gnail.com', 'gmaul.com', 'gmeil.com',
    'gmail.con', 'gmail.cm', 'gmail.co', 'gmail.c', 'gmail.om', 'gmail.comm', 'gmail.cmo', 'gmail.ocm', 'gmail.vom', 'gmail.xom', 'gmailcom',
  ],
  'hotmail.com': [
    'hotmial.com', 'hotmal.com', 'hotmil.com', 'hotmai.com', 'hotmaill.com', 'hotnail.com', 'homail.com', 'hotamil.com',
    'hotmail.con', 'hotmail.cm', 'hotmail.co', 'hotmail.c', 'hotmail.om', 'hotmailcom',
  ],
  'yahoo.com': ['yaho.com', 'yahooo.com', 'yhoo.com', 'yahho.com', 'yaoo.com', 'yahoo.con', 'yahoo.cm', 'yahoo.c', 'yahoo.om', 'yahoocom'],
  'outlook.com': ['outlok.com', 'outllok.com', 'outloo.com', 'outook.com', 'oulook.com', 'otlook.com', 'outlookk.com', 'outlook.con', 'outlook.cm', 'outlook.co', 'outlookcom'],
  'icloud.com': ['iclod.com', 'icoud.com', 'iclould.com', 'icloud.con', 'icloud.cm', 'icloud.co', 'icluod.com', 'icloudcom'],
  'live.com': ['live.con', 'live.cm'],
  'aol.com': ['aol.con', 'aol.cm', 'aoll.com'],
};
const TYPO_FIX: ReadonlyMap<string, string> = new Map(
  Object.entries(TYPO_DOMAINS).flatMap(([good, typos]) => typos.map((t) => [t, good] as const)),
);

/**
 * The address the person probably meant, or null. `jon@gmial.com` -> `jon@gmail.com`.
 * The local part is kept exactly as typed; only a known misspelt domain is replaced.
 */
export function suggestEmailFix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  const fix = TYPO_FIX.get(s.slice(at + 1).toLowerCase());
  return fix ? `${s.slice(0, at)}@${fix}` : null;
}
