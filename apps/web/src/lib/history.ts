// Anonymous job history (P3-7) — localStorage-driven, no account, no raw IP.
// The signed cookie (api/history/set-cookie) is a tamper-evident backup; the UI
// renders from localStorage.
const HISTORY_KEY = 'stem-loops-history';
const MAX = 20;

export function getHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function addToHistory(jobId: string): void {
  if (typeof window === 'undefined') return;
  const history = getHistory().filter((id) => id !== jobId);
  history.unshift(jobId);
  const trimmed = history.slice(0, MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  // Best-effort: mirror to a signed httpOnly cookie (tamper-evident backup).
  fetch('/api/history/set-cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds: trimmed }),
  }).catch(() => {});
}
