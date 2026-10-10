import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toBool } from "../common/values";

// Licence register (statutory permits per store). Each opening project gets the tenant's licence
// types; a store cannot open until every mandatory licence is issued and valid on the opening day.

export interface LicenceType { code: string; name: string; authority: string; mandatory: boolean; renew_days?: number }

/** India QSR defaults; a tenant overrides them with settings_json.licence_types. */
export const DEFAULT_LICENCE_TYPES: LicenceType[] = [
  { code: "FSSAI", name: "FSSAI food business licence", authority: "Food Safety and Standards Authority of India", mandatory: true, renew_days: 60 },
  { code: "TRADE", name: "Trade licence", authority: "Municipal corporation", mandatory: true, renew_days: 45 },
  { code: "FIRE_NOC", name: "Fire NOC", authority: "State fire services", mandatory: true, renew_days: 60 },
  { code: "SHOP_EST", name: "Shop and Establishment registration", authority: "State labour department", mandatory: true, renew_days: 45 },
  { code: "GST", name: "GST registration", authority: "GST department", mandatory: true },
  { code: "SIGNAGE", name: "Signage permit", authority: "Municipal corporation", mandatory: false, renew_days: 30 },
];

export const LICENCE_STATES = ["NOT_STARTED", "APPLIED", "ISSUED", "REJECTED", "EXPIRED"] as const;
const DEFAULT_RENEW_DAYS = 45;

function settingsOf(tenant: Row | null): Record<string, unknown> {
  try { return JSON.parse(String(tenant?.settings_json ?? "{}")); } catch { return {}; }
}

export function licenceTypes(tenant: Row | null): LicenceType[] {
  const custom = settingsOf(tenant).licence_types;
  return Array.isArray(custom) && custom.length ? (custom as LicenceType[]) : DEFAULT_LICENCE_TYPES;
}

/** Days before expiry when renewal reminders start, by licence code. */
export function renewDays(tenant: Row | null, code: string): number {
  return licenceTypes(tenant).find((t) => t.code === code)?.renew_days ?? DEFAULT_RENEW_DAYS;
}

/** Creates the tenant's licence types on a project once; existing rows are left alone. */
export async function ensureLicences(store: Store, ctx: TenantContext, project: Row): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const existing = await repo.findMany("licences", { project_id: pid }, { limit: 100 });
  const have = new Set(existing.map((l) => String(l.licence_code)));
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  for (const t of licenceTypes(tenant)) {
    if (have.has(t.code)) continue;
    try {
      existing.push(await repo.insert("licences", {
        project_id: pid, franchisee_id: project.franchisee_id ?? null, licence_code: t.code, name: t.name, authority: t.authority,
        mandatory: t.mandatory, status: "NOT_STARTED", licence_key: `${ctx.tenantId}:${pid}:${t.code}`,
      }));
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e; // a concurrent call created it
    }
  }
  return sortLicences(existing);
}

const sortLicences = (rows: Row[]) => rows.sort((a, b) => Number(toBool(b.mandatory)) - Number(toBool(a.mandatory)) || String(a.name).localeCompare(String(b.name)));

export interface LicenceChange {
  status?: (typeof LICENCE_STATES)[number];
  licence_number?: string | null;
  applied_on?: string | null;
  issued_on?: string | null;
  expires_on?: string | null;
  notes?: string | null;
  owner_user_id?: string | null;
  file_ref?: string;
}

/** Validates and records a change. Issued needs an issue date; an expiry must come after it. */
export async function updateLicence(store: Store, ctx: TenantContext, licence: Row, change: LicenceChange, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const next = { ...licence, ...change };
  const fields: Record<string, string> = {};
  if (next.status === "ISSUED" && !next.issued_on) fields.issued_on = "required when issued";
  if (next.issued_on && next.expires_on && String(next.expires_on) <= String(next.issued_on)) fields.expires_on = "must be after the issue date";
  if (next.issued_on && String(next.issued_on).slice(0, 10) > today) fields.issued_on = "can't be in the future";
  if (Object.keys(fields).length) throw new AppError("VALIDATION_FAILED", "Check the licence dates.", fields);
  // A renewal with a future expiry brings an expired licence back.
  if (change.expires_on && licence.status === "EXPIRED" && change.status === undefined && String(change.expires_on) > today) change.status = "ISSUED";
  const row = await repo.update("licences", String(licence.ROWID), change as Row);
  const action = change.status && change.status !== licence.status ? `licence:${change.status.toLowerCase()}` : change.file_ref ? "licence:upload" : "licence:update";
  await logActivity(store, ctx, { entityType: "licence", entityId: String(licence.ROWID), action, metadata: { project_id: licence.project_id, code: licence.licence_code, fields: Object.keys(change) } });
  return row;
}

/** Mandatory licences that stop a store opening on `openingDate`: not issued, or not valid that day. */
export async function openingBlockers(store: Store, ctx: TenantContext, project: Row, openingDate: string): Promise<Row[]> {
  const licences = await ensureLicences(store, ctx, project);
  return licences.filter((l) => toBool(l.mandatory) && (l.status !== "ISSUED" || (l.expires_on && String(l.expires_on).slice(0, 10) <= openingDate)));
}

export async function assertLicencesReady(store: Store, ctx: TenantContext, project: Row, openingDate: string): Promise<void> {
  const missing = await openingBlockers(store, ctx, project, openingDate);
  if (!missing.length) return;
  throw new AppError("LICENCES_MISSING", `The store can't open until these licences are issued: ${missing.map((l) => l.name).join(", ")}.`,
    Object.fromEntries(missing.map((l) => [String(l.licence_code), l.status === "ISSUED" ? "expires before opening" : String(l.status).toLowerCase().replace("_", " ")])));
}

/** Daily: issued licences past their expiry become EXPIRED (logged, so people are told). */
export async function expireLicences(store: Store, ctx: TenantContext, today: string): Promise<number> {
  const repo = new TenantRepo(store, ctx.tenantId);
  let n = 0;
  for (const l of await repo.findMany("licences", { status: "ISSUED" })) {
    if (!l.expires_on || String(l.expires_on).slice(0, 10) >= today) continue;
    await repo.update("licences", String(l.ROWID), { status: "EXPIRED" });
    await logActivity(store, ctx, { entityType: "licence", entityId: String(l.ROWID), action: "licence:expired", metadata: { project_id: l.project_id, code: l.licence_code, expires_on: l.expires_on } });
    n++;
  }
  return n;
}
