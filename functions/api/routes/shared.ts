import { AppError, ErrorCode } from "../../common/errors";
import { isPortalUser } from "../../common/rbac";
import { Row, TenantRepo } from "../../common/store";
import { Call } from "../router";
import { z } from "zod";
import { randomUUID } from "crypto";
import { refreshReadiness, updateChecklistItem } from "../../workflows/readiness";
import { MAX_UPLOAD_BYTES, STRATUS_PREFIX, UPLOAD_TYPES, safeFileName } from "../../common/files";

/** A base64 file in a JSON body (PDF or image, up to MAX_UPLOAD_BYTES). */
export const uploadSchema = z.object({ file_name: z.string().trim().min(1).max(200), content_type: z.string().max(100), data_base64: z.string().min(1) }).strict();

/** Checks and stores an uploaded file under tenants/<t>/<prefix>/<uuid>/; returns its file_ref. */
export async function storeUpload(call: Call, prefix: string, file: z.infer<typeof uploadSchema>): Promise<string> {
  if (!call.files) throw new AppError("FILE_STORAGE_UNAVAILABLE", "File uploads aren't set up yet.");
  if (!UPLOAD_TYPES[file.content_type]) throw new AppError("VALIDATION_FAILED", "Upload a PDF, JPG, PNG or WebP file.", { file: "unsupported type" });
  const data = Buffer.from(file.data_base64, "base64");
  if (!data.length) throw new AppError("VALIDATION_FAILED", "The file is empty.", { file: "empty" });
  if (data.length > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION_FAILED", `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, { file: "too large" });
  const key = `tenants/${call.ctx.tenantId}/${prefix}/${randomUUID()}/${safeFileName(file.file_name)}`;
  await call.files.put(key, data, file.content_type);
  return `${STRATUS_PREFIX}${key}`;
}

/** A short-lived download link for a stored file_ref. */
export async function signedUrl(call: Call, ref: string, missing: string): Promise<{ url: string }> {
  if (!ref.startsWith(STRATUS_PREFIX)) throw new AppError("NOT_FOUND", missing);
  if (!call.files) throw new AppError("FILE_STORAGE_UNAVAILABLE", "File storage isn't set up.");
  return { url: await call.files.downloadUrl(ref.slice(STRATUS_PREFIX.length)) };
}

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

/**
 * Marks the project's checklist tasks with these codes done (in Zoho Projects too when linked) and
 * refreshes readiness. Returns the codes actually completed; a task Zoho refuses stays open and can
 * be closed by hand, so the change that triggered it still stands.
 */
export async function completeTasks(call: Call, project: Row, codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const pid = String(project.ROWID);
  const items = (await call.repo.findMany("opening_checklists", { project_id: pid }, { limit: 300 }))
    .filter((i) => codes.includes(String(i.task_code)) && i.status !== "COMPLETED");
  if (!items.length) return [];
  const linked = !!project.zoho_project_id && items.some((i) => i.external_task_id);
  const projects = linked ? (await call.zoho().catch(() => null))?.projects ?? null : null;
  const done: string[] = [];
  for (const item of items) {
    try {
      await updateChecklistItem(call.store, call.ctx, projects, pid, String(item.ROWID), { done: true });
      done.push(String(item.task_code));
    } catch { /* left open */ }
  }
  if (done.length) await refreshReadiness(call.store, call.ctx, pid, { today: call.now.toISOString().slice(0, 10), now: call.now, onTransition: call.onTransition }).catch(() => undefined);
  return done;
}
