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
//   - Breadcrumbs (fetch/xhr/http, navigation, console) ride along on every error
//     event, so they are scrubbed when recorded: no query strings (signed R2 URLs),
//     no URL credentials, job ids masked, presigned requests reduced to origin +
//     method + status. Exception messages themselves are not rewritten.

export const tracesSampler = (): number => 0;

// A job id is a UUID. It appears in /jobs/<id> and /api/jobs/<id>, and also leads
// every R2 key (`<jobId>/...`), so any UUID is masked, not only the /jobs/ forms.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PRESIGNED = /[?&]X-Amz-(Signature|Credential)=/i;
const ABS_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const DROP_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-forwarded-for|x-real-ip|forwarded|cf-connecting-ip|true-client-ip|x-vercel-forwarded-for|x-vercel-proxied-for)$/i;
const DROP_SPAN_ATTR = /(cookie|authorization|token|secret|client\.address|user\.ip|ip_address)/i;

export function maskJobIds(s: string): string {
  return s.replace(UUID, '[id]');
}

const stripUserinfo = (u: string): string => u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1[redacted]@');

// Absolute or relative URL -> no query, fragment or credentials, job ids masked.
// A presigned URL (R2 GET/PUT) keeps only its origin: its path is the object key.
const presignedOrigin = (u: string): string => `${stripUserinfo(ORIGIN.exec(u)?.[0] ?? '')}/[presigned]`;

export function scrubUrl(u: string): string {
  if (PRESIGNED.test(u)) return presignedOrigin(u);
  return maskJobIds(stripUserinfo(u.split(/[?#]/)[0]));
}

// Free text (log/console messages): scrub every absolute URL, then mask job ids.
export function scrubText(s: string): string {
  return maskJobIds(s.replace(ABS_URL, (u) => scrubUrl(u)));
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

const CRUMB_URL_KEYS = new Set(['url', 'from', 'to']);
// Raw console arguments, request/response bodies and the Node http query/fragment.
const DROP_CRUMB_DATA = /^(arguments|body|request_body|response_body|http\.query|http\.fragment)$/;
const KEEP_PRESIGNED = new Set(['url', 'method', 'http.method', 'status_code']);

export function beforeBreadcrumb<T extends { message?: string; data?: Record<string, unknown> }>(crumb: T): T {
  if (typeof crumb.message === 'string') crumb.message = scrubText(crumb.message);
  const d = crumb.data;
  if (d) {
    // The Node SDK moves the query into `http.query` before this hook runs.
    const presigned = [d.url, d['http.query']].some((v) => typeof v === 'string' && PRESIGNED.test(v));
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (DROP_CRUMB_DATA.test(k) || (presigned && !KEEP_PRESIGNED.has(k))) delete d[k];
      else if (typeof v !== 'string') continue;
      else if (presigned && k === 'url') d[k] = presignedOrigin(v);
      else d[k] = CRUMB_URL_KEYS.has(k) ? scrubUrl(v) : scrubText(v);
    }
  }
  return crumb;
}
