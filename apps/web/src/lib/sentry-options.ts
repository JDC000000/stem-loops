// Shared Sentry options for every runtime (browser, Node, Edge). Dependency-free.
//
// Security review 2026-10-03: with tracesSampleRate 0.2 and no hooks, production
// sent (a) the raw request cookies, including the signed `sl-history` cookie
// (the visitor's job ids), on server transactions (SDK transactions bypass
// cookie filtering and beforeSend), (b) job ids in page/fetch URLs, and a job id
// is a bearer capability (GET /api/jobs/:id mints fresh signed loop URLs), and
// (c) client IPs on interaction spans.
//
//   - Tracing is OFF. A `tracesSampler` returning 0, not `tracesSampleRate: 0`:
//     with only a rate, an inbound `sentry-trace: ...-1` header makes the SDK
//     inherit "sampled" and send a transaction anyway.
//   - Errors and (if tracing is ever re-enabled) transactions go through one
//     scrubber: no cookies, no auth/IP headers, no query string, job ids masked.
//   - Spans lose cookie/auth/IP attributes and have job ids masked in URLs.

export const tracesSampler = (): number => 0;

const JOB_ID = /\/(api\/)?jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DROP_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-forwarded-for|x-real-ip|forwarded|cf-connecting-ip|true-client-ip|x-vercel-forwarded-for|x-vercel-proxied-for)$/i;
const DROP_SPAN_ATTR = /(cookie|authorization|token|secret|client\.address|user\.ip|ip_address)/i;

export function maskJobIds(s: string): string {
  return s.replace(JOB_ID, (_m, api) => `/${api ?? ''}jobs/[id]`);
}

type Req = {
  url?: string;
  query_string?: unknown;
  cookies?: unknown;
  headers?: Record<string, unknown> | null;
  data?: unknown;
};
type Ev = { request?: Req | null; user?: Record<string, unknown> | null; transaction?: string };

export function scrubEvent<T extends Ev>(event: T): T {
  const r = event.request;
  if (r) {
    delete r.cookies;
    delete r.query_string;
    delete r.data;
    if (typeof r.url === 'string') r.url = maskJobIds(r.url.split('?')[0]);
    if (r.headers) {
      for (const k of Object.keys(r.headers)) if (DROP_HEADER.test(k)) delete r.headers[k];
    }
  }
  if (event.user) {
    delete event.user.ip_address;
    delete event.user.email;
  }
  if (typeof event.transaction === 'string') event.transaction = maskJobIds(event.transaction);
  return event;
}

export const beforeSend = scrubEvent;
export const beforeSendTransaction = scrubEvent;

export function beforeSendSpan<T extends { data?: Record<string, unknown>; description?: string }>(
  span: T,
): T {
  if (span.data) {
    for (const k of Object.keys(span.data)) {
      if (DROP_SPAN_ATTR.test(k)) delete span.data[k];
      else if (typeof span.data[k] === 'string') span.data[k] = maskJobIds(span.data[k] as string);
    }
  }
  if (typeof span.description === 'string') span.description = maskJobIds(span.description);
  return span;
}
