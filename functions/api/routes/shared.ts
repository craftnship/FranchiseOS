import { AppError, ErrorCode } from "../../common/errors";
import { isPortalUser } from "../../common/rbac";
import { Row, TenantRepo } from "../../common/store";
import { Call } from "../router";

export async function mustGet(repo: TenantRepo, table: string, id: string, code: ErrorCode): Promise<Row> {
  const row = await repo.findOne(table, { ROWID: id });
  if (!row) throw new AppError(code);
  return row;
}

/**
 * Portal users (franchisee, staff, vendor) only see rows of their own franchisee (§25, FOS-048).
 * A row they do not own reads as not found so ids cannot be probed.
 */
export function assertOwner(call: Call, row: Row, code: ErrorCode, field = "franchisee_id"): Row {
  if (!isPortalUser(call.ctx)) return row;
  if (!call.ctx.franchiseeId || String(row[field]) !== call.ctx.franchiseeId) throw new AppError(code);
  return row;
}

/** Extra filter applied to list queries for portal users. */
export function ownerFilter(call: Call, field = "franchisee_id"): Record<string, string> {
  if (!isPortalUser(call.ctx)) return {};
  if (!call.ctx.franchiseeId) throw new AppError("ACCESS_DENIED", "Portal user is not linked to a franchisee.");
  return { [field]: call.ctx.franchiseeId };
}

export function settings(tenant: Row | null): Record<string, unknown> {
  try { return tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { return {}; }
}

/** Drops undefined values so PATCH bodies only write what was sent. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Every row of a table for this tenant, paged past the 300-row ZCQL cap (dashboards, pilot scale). */
export async function fetchAll(repo: TenantRepo, table: string, where: Record<string, string> = {}, max = 3000): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; offset < max; offset += 300) {
    const rows = await repo.findMany(table, where, { orderBy: "ROWID", limit: 300, offset });
    out.push(...rows);
    if (rows.length < 300) break;
  }
  return out;
}

/**
 * List filter for `status=A,B,C` (dashboard drill-downs): one query per status, merged newest first.
 * A single status keeps the plain paged query.
 */
export async function listByStatus(repo: TenantRepo, table: string, status: string | undefined, where: Record<string, string>, page: { limit: number; offset: number }): Promise<Row[]> {
  const statuses = (status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.length <= 1) {
    return repo.findMany(table, { ...where, ...(statuses[0] ? { status: statuses[0] } : {}) }, { orderBy: "CREATEDTIME", desc: true, limit: page.limit, offset: page.offset });
  }
  const rows = (await Promise.all(statuses.map((s) => fetchAll(repo, table, { ...where, status: s })))).flat();
  rows.sort((a, b) => String(b.CREATEDTIME ?? "").localeCompare(String(a.CREATEDTIME ?? "")));
  return rows.slice(page.offset, page.offset + page.limit);
}

export const PORTAL_ROLES = ["FRANCHISEE", "FRANCHISEE_STAFF", "VENDOR"];

/** Every user of the tenant by id, with their role code; `active` means active staff (not a portal user). */
export async function staffDirectory(call: Call): Promise<Map<string, { ROWID: string; name: string | null; email: string; role: string; active: boolean }>> {
  const [users, roles] = await Promise.all([call.repo.findMany("users", {}, { limit: 500 }), call.repo.findMany("roles", {}, { limit: 100 })]);
  const roleCode = new Map(roles.map((x) => [String(x.ROWID), String(x.code)]));
  return new Map(users.map((u) => [String(u.ROWID), {
    ROWID: String(u.ROWID), name: u.name ? String(u.name) : null, email: String(u.email),
    role: roleCode.get(String(u.role_id)) ?? "", active: u.status === "ACTIVE" && !u.franchisee_id,
  }]));
}
