// Open-redirect guard for `?return_to=`. Only same-origin absolute paths are
// accepted ("/account", "/pricing?x=1"); anything else falls back.
export function sanitizeReturnTo(raw: string | null | undefined, fallback = '/account'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  if (!raw.startsWith('/')) return fallback;
  // "//evil.com" and "/\evil.com" are protocol-relative / browser-normalised to external hosts.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f]/.test(raw)) return fallback;
  return raw;
}
