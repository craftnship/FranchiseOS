// Thin client for the fos_api function. Same-origin on Catalyst hosting, so the Catalyst sign-in
// cookie authenticates every call.
export const API_BASE = "/server/fos_api";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly fields?: Record<string, string>) { super(message); }
}

// A page firing many reads at once can trip Data Store's burst limit, so at most four requests
// run together and a read that fails on the server is tried once more.
const MAX_PARALLEL = 4;
let running = 0;
const queue: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

export async function api<T>(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
  try {
    return await slot(() => request<T>(method, path, opts));
  } catch (e) {
    const retry = method === "GET" && (!(e instanceof ApiError) || e.status >= 500 || e.code === "NETWORK");
    if (!retry) throw e;
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    return slot(() => request<T>(method, path, opts));
  }
}

async function request<T>(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown }): Promise<T> {
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

export interface Me { user_id: string; tenant_id: string; roles: string[]; franchisee_id: string | null; name?: string | null; email?: string | null; region?: string | null; permissions?: string[]; zoho_web?: ZohoWeb | null }
export interface ZohoWeb { crm: string; sign: string; books: string; books_org: string | null }

let current: Me | null = null;
export const setCurrentUser = (me: Me | null) => { current = me; };
export const currentUser = () => current;
/** Hides actions the signed-in user cannot take; the API enforces the same rule. */
export const can = (permission: string) => !!current?.permissions && (current.permissions.includes("*") || current.permissions.includes(permission));
/** True for SUPER_ADMIN or a user holding the role; delegations are checked by the API. */
export const actsAs = (role: string) => !!current && (current.roles.includes("SUPER_ADMIN") || current.roles.includes(role));
export const hasRole = (role: string) => !!current?.roles.includes(role);
export const myRoles = () => current?.roles ?? [];
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

// A franchisee with several stores picks the one the portal pages show; kept per browser.
const STORE_KEY = "fos.portal.store";
export const portalStore = (): string | null => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
export const setPortalStore = (id: string | null) => { try { if (id) localStorage.setItem(STORE_KEY, id); else localStorage.removeItem(STORE_KEY); } catch { /* storage blocked: stay on the default store */ } };
export const portalHome = () => { const id = portalStore(); return api<Row>("GET", "/portal/home", id ? { query: { project_id: id } } : {}); };

/** Web links to a record in Zoho, for staff; null when the tenant's Zoho isn't known. */
export const zohoLink = {
  books: (invoiceId: unknown) => { const w = current?.zoho_web; return w?.books_org && invoiceId ? `${w.books}/app/${w.books_org}#/invoices/${invoiceId}` : null; },
  crmAccount: (accountId: unknown) => { const w = current?.zoho_web; return w && accountId ? `${w.crm}/crm/tab/Accounts/${accountId}` : null; },
  sign: (requestId: unknown) => { const w = current?.zoho_web; return w && requestId ? `${w.sign}/zs#/request/details/${requestId}` : null; },
};
