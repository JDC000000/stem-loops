// Server-side GET against our own /api/* routes, forwarding the visitor's
// cookies so the route sees the same Supabase session. Never throws: pages
// degrade to a friendly message when a route is missing or erroring.
import { cookies, headers } from 'next/headers';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

export async function serverGet<T>(path: string): Promise<ApiResult<T>> {
  try {
    const h = headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (!host) return { ok: false, status: 0 };
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
    const cookie = cookies().toString();
    const res = await fetch(`${proto}://${host}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

export type CreditsBalance = {
  credits_remaining: number;
  purchases?: Array<{ pack_code?: string; credits_granted?: number; amount_cad_cents?: number; created_at?: string }>;
  recent_consumption?: Array<{ job_id?: string; consumed_at?: string }>;
};

export type Entitlements = {
  plan_code: string;
  period_start?: string | null;
  period_end?: string | null;
  jobs_used?: number;
  jobs_quota?: number;
  services?: string[];
  export?: unknown;
};
