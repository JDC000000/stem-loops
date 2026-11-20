'use client';

// Vercel Web Analytics for every route (decision 2A). A client wrapper because the root
// layout is a Server Component and cannot hand `beforeSend` (a function) to a client one.
// The script and its endpoints are first-party (/_vercel/insights/* or Vercel's per-project
// path on this origin), so the middleware CSP's 'self' already covers them. No cookies.
import { Analytics } from '@vercel/analytics/next';
import { scrubAnalyticsUrl } from '@/lib/analytics';

export default function SiteAnalytics() {
  return <Analytics beforeSend={scrubAnalyticsUrl} />;
}
