// Vercel Web Analytics (decision 2A): page views + three custom events, nothing else.
//
// Privacy contract (pinned by test/web-analytics.test.mjs and the /privacy line):
//   • No cookies: Vercel identifies a visit by a request hash that resets daily.
//   • Page-view URLs are sent WITHOUT query string or fragment (scrubAnalyticsUrl), so
//     auth codes, Stripe session ids, return_to targets and the like never leave the app.
//   • Custom events carry only the closed, non-personal props typed below — never an email,
//     user id, job id, song URL or file name. The type is the allowlist.
//
// This is the ONLY module that imports `@vercel/analytics` for events; call sites use
// trackEvent(). Custom events are recorded on Vercel Pro and up; on Hobby the dashboard
// shows page views only and these calls are harmless.
import { track } from '@vercel/analytics';

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

/** beforeSend: drop the query string and fragment from every URL sent to Vercel. */
export function scrubAnalyticsUrl<E extends OutgoingEvent>(event: E): E {
  try {
    const u = new URL(event.url);
    return { ...event, url: `${u.origin}${u.pathname}` };
  } catch {
    const cut = event.url.search(/[?#]/);
    return cut === -1 ? event : { ...event, url: event.url.slice(0, cut) };
  }
}
