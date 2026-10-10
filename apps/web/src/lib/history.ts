// Anonymous job history (P3-7) — localStorage-driven, no account, no raw IP.
// The signed cookie (api/history/set-cookie) is a tamper-evident backup; the UI
// renders from localStorage.
//
// Jobs and their files are deleted 24h after creation (see retention.ts), so each entry
// stores when it was added and entries older than the retention window are dropped on
// read — the history never lists jobs that are guaranteed to 404.
import { RETENTION_MS } from '@/lib/retention';

const HISTORY_KEY = 'stem-loops-history';
const MAX = 20;

export interface HistoryEntry {
  id: string;
  /** ms epoch the job was added (≈ created_at). */
  at: number;
}

function readRaw(): HistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    // Pre-24h-retention entries were bare id strings with no timestamp; their age is
    // unknown and most are already deleted, so they are dropped (one-time, harmless).
    return v.filter(
      (e): e is HistoryEntry =>
        e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'number',
    );
  } catch {
    return [];
  }
}

/** Live (not yet expired) entries, newest first. */
export function getHistoryEntries(now: number = Date.now()): HistoryEntry[] {
  if (typeof window === 'undefined') return [];
  return readRaw().filter((e) => now - e.at < RETENTION_MS);
}

export function getHistory(): string[] {
  return getHistoryEntries().map((e) => e.id);
}

export function addToHistory(jobId: string): void {
  if (typeof window === 'undefined') return;
  const entries = getHistoryEntries().filter((e) => e.id !== jobId);
  entries.unshift({ id: jobId, at: Date.now() });
  const trimmed = entries.slice(0, MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  // Best-effort: mirror the ids to a signed httpOnly cookie (tamper-evident backup).
  fetch('/api/history/set-cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds: trimmed.map((e) => e.id) }),
  }).catch(() => {});
}
