import { randomBytes, timingSafeEqual } from "crypto";
import { TenantContext } from "./context";
import { AppError } from "./errors";
import { Row, Store } from "./store";

// Read-only demo links (docs/deploy-pilot.md, "Demo link"): a super admin creates one from
// Settings, anyone holding it sees the brand's screens with sample data and no sign-in. The
// link names the tenant and carries a random token kept in the tenant's settings with an expiry;
// the server gives it a DEMO_VIEWER context that can only read, masks contact details in every
// response, and makes no Zoho calls.

export const DEMO_ROLE = "DEMO_VIEWER";
export const DEMO_USER_ID = "DEMO";
/** What the demo may read: the staff screens, money included, and nothing in Admin. */
export const DEMO_PERMISSIONS = new Set(["dashboard.view", "finance.view", "audit.view"]);
export const DEMO_MAX_DAYS = 90;
export const DEMO_DEFAULT_DAYS = 30;

export interface DemoLink { token: string; expires_on: string; created_at: string; created_by: string | null }

const settingsOf = (tenant: Row | null): Row => { try { return tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { return {}; } };
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** A new link for the tenant, replacing any earlier one. Returns the token the link carries. */
export async function createDemoLink(store: Store, tenant: Row, days: number, now: Date, createdBy: string | null): Promise<{ token: string; expires_on: string }> {
  const settings = settingsOf(tenant);
  const link: DemoLink = { token: randomBytes(24).toString("base64url"), expires_on: day(addDays(now, days)), created_at: now.toISOString(), created_by: createdBy };
  settings.demo_link = link;
  await store.update("tenants", String(tenant.ROWID), { settings_json: JSON.stringify(settings) });
  return { token: `${tenant.tenant_code}.${link.token}`, expires_on: link.expires_on };
}

export async function revokeDemoLink(store: Store, tenant: Row): Promise<void> {
  const settings = settingsOf(tenant);
  delete settings.demo_link;
  await store.update("tenants", String(tenant.ROWID), { settings_json: JSON.stringify(settings) });
}

/** The tenant's current link, if it has one that has not lapsed. */
export function demoLinkOf(tenant: Row | null, now: Date): DemoLink | null {
  const link = settingsOf(tenant).demo_link as DemoLink | undefined;
  if (!link?.token || !link.expires_on) return null;
  return link.expires_on >= day(now) ? link : null;
}

/** The context a valid demo token gets; a missing, revoked or lapsed one is refused. */
export async function resolveDemo(store: Store, token: string, now: Date, ids: { requestId: string; correlationId?: string }): Promise<TenantContext> {
  const dot = token.indexOf(".");
  const code = dot > 0 ? token.slice(0, dot) : "", secret = dot > 0 ? token.slice(dot + 1) : "";
  const tenant = /^[A-Z0-9_]{2,40}$/.test(code) ? await store.findOne("tenants", { tenant_code: code, status: "ACTIVE" }) : null;
  const link = demoLinkOf(tenant, now);
  const want = Buffer.from(link?.token ?? ""), given = Buffer.from(secret);
  if (!tenant || !link || want.length === 0 || want.length !== given.length || !timingSafeEqual(want, given)) throw new AppError("DEMO_LINK_INVALID");
  return { tenantId: String(tenant.ROWID), userId: DEMO_USER_ID, roles: [DEMO_ROLE], zohoDc: String(tenant.zoho_dc), requestId: ids.requestId, correlationId: ids.correlationId ?? ids.requestId, demo: true };
}

/** A store whose writes go nowhere: reads that tidy up as a side effect still answer, and nothing changes. */
export function readOnlyStore(store: Store): Store {
  return {
    findOne: (t, w) => store.findOne(t, w),
    findMany: (t, w, o) => store.findMany(t, w, o),
    insert: async (_t, row) => ({ ROWID: "0", ...row }),
    update: async (t, rowId, patch) => ({ ...(await store.findOne(t, { ROWID: rowId })), ...patch, ROWID: rowId }),
  };
}

const CONTACT_KEY = /(^|_)(email|emails|phone|mobile|whatsapp|contact_number|emailed_to)(_|$)/i;

export const maskEmail = (s: string): string => {
  const at = s.indexOf("@");
  if (at <= 0) return maskDigits(s);
  return `${s[0]}•••${s.slice(at)}`;
};
export const maskDigits = (s: string): string => {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 6 ? `${digits.slice(0, 2)}${"•".repeat(digits.length - 5)}${digits.slice(-3)}` : s.replace(/[A-Za-z0-9]/g, "•");
};

/** Contact details in a demo response read as s•••@example.com and 90•••••903, whatever the row. */
export function maskContacts<T>(data: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key && CONTACT_KEY.test(key) && v.trim() ? maskEmail(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(data) as T;
}
