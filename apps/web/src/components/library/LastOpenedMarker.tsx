'use client';

// Records "this song was opened now" in localStorage, for the library's Recent sort (Phase B,
// B1; lib/library.ts recordLastOpened). Mounted by app/jobs/[id]/layout.tsx. Renders nothing,
// fetches nothing and sends nothing anywhere: the map stays on this browser.
import { useEffect } from 'react';
import { recordLastOpened } from '@/lib/library';

export function LastOpenedMarker({ jobId }: { jobId: string }) {
  useEffect(() => {
    try {
      recordLastOpened(window.localStorage, jobId);
    } catch {
      // Storage blocked: Recent falls back to when the song was made.
    }
  }, [jobId]);
  return null;
}
