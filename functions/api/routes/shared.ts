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
