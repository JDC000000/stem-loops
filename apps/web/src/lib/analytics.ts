// Vercel Web Analytics (decision 2A): page views + three custom events, nothing else.
//
// Privacy contract (pinned by test/web-analytics.test.mjs and the /privacy line):
//   • No cookies: Vercel identifies a visit by a request hash that resets daily.
//   • Page-view and event URLs are sent WITHOUT query string or fragment, and with every
//     UUID in the path masked to [id] (scrubAnalyticsUrl). Auth codes, Stripe session ids,
//     return_to targets never leave the app, and neither does a job id: for a job started
//     without an account its id is the only credential (lib/job-access.ts), and for an owned
//     one it is a per-user identifier. Same mask as Sentry (lib/sentry-options.ts maskJobIds).
//   • Referrers: the middleware sends Referrer-Policy: strict-origin, so document.referrer
//     (which Vercel records and beforeSend cannot touch) is at most the bare origin.
//   • Custom events carry only the closed, non-personal props typed below — never an email,
//     user id, job id, song URL or file name. The type is the allowlist.
//
// This is the ONLY module that imports `@vercel/analytics` for events; call sites use
// trackEvent(). Custom events are recorded on Vercel Pro and up; on Hobby the dashboard
// shows page views only and these calls are harmless.
import { track } from '@vercel/analytics';
import { maskJobIds } from '@/lib/sentry-options';

export interface AnalyticsEvents {
  /** A visitor opened a demo song in the home-page player. `song` is the public catalog slug. */
  demo_play: { song: string };
  /** A job was created (POST /api/jobs succeeded). `source` is how the song came in. */
  song_added: { source: 'link' | 'file' };
  /** The signup route created an account. No props. */
  signup: Record<string, never>;
}
export type AnalyticsEventName = keyof AnalyticsEvents;

/** Fire one custom event. Never throws: analytics must not break a user flow. */
export function trackEvent<K extends AnalyticsEventName>(name: K, props: AnalyticsEvents[K]): void {
  try {
    const entries = Object.entries(props);
    track(name, entries.length ? (props as Record<string, string>) : undefined);
  } catch {
    // intentional: an ad blocker or a missing script must never surface to the user.
  }
}

/** Shape of the event Vercel's beforeSend hands us (url is absolute). */
interface OutgoingEvent {
  type: 'pageview' | 'event';
  url: string;
}

/** beforeSend: drop the query string and fragment, and mask every UUID in the path to [id]. */
export function scrubAnalyticsUrl<E extends OutgoingEvent>(event: E): E {
  let url: string;
  try {
    const u = new URL(event.url);
    url = `${u.origin}${u.pathname}`;
  } catch {
    const cut = event.url.search(/[?#]/);
    url = cut === -1 ? event.url : event.url.slice(0, cut);
  }
  return { ...event, url: maskJobIds(url) };
}

/**
 * Best-effort grace before a full-page navigation that follows trackEvent(), so the queued
 * event has a moment to go out before the page unloads. Bounded (NAV_GRACE_MS); it never
 * blocks on the network, and an event can still be lost (e.g. the tracker script has not
 * loaded yet, or the browser cancels the request on unload).
 */
export const NAV_GRACE_MS = 150;
export function navigationGrace(ms: number = NAV_GRACE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, NAV_GRACE_MS)));
}
