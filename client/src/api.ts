// Thin client for the fos_api function. Same-origin on Catalyst hosting, so the Catalyst sign-in
// cookie authenticates every call.
export const API_BASE = "/server/fos_api";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly fields?: Record<string, string>) { super(message); }
}

export async function api<T>(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();
  const res = await fetch(`${API_BASE}${path}${qs ? `?${qs}` : ""}`, {
    method,
    credentials: "include",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const e = json.error ?? {};
    throw new ApiError(e.code ?? "NETWORK", e.message ?? `Request failed (${res.status})`, res.status, e.fields);
  }
  return json.data as T;
}

export interface Me { user_id: string; tenant_id: string; roles: string[]; franchisee_id: string | null; permissions?: string[] }

let current: Me | null = null;
export const setCurrentUser = (me: Me | null) => { current = me; };
/** Hides actions the signed-in user cannot take; the API enforces the same rule. */
export const can = (permission: string) => !!current?.permissions && (current.permissions.includes("*") || current.permissions.includes(permission));
export type Row = Record<string, any>;
export interface Kpi { value: number | null; drill?: { path: string; query: Record<string, string> } }

/** Turns a KPI drill into an app route, e.g. /projects?delayed=true. */
export function drillHref(k: Kpi): string | undefined {
  if (!k.drill) return undefined;
  const qs = new URLSearchParams(k.drill.query).toString();
  return `${k.drill.path}${qs ? `?${qs}` : ""}`;
}

export const PORTAL_ROLES = ["FRANCHISEE", "FRANCHISEE_STAFF", "VENDOR"];
export const isPortal = (me: Me) => me.roles.every((r) => PORTAL_ROLES.includes(r));
