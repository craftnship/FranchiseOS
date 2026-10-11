import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { Row, Store, TenantRepo } from "../common/store";
import { toNum, toNumOrNull } from "../common/values";

// Construction depth for an opening project: the brand design approved before fit-out, dated and
// located site photos, and a snag list that has to be cleared before the store opens.
//
// Design:  SUBMITTED → APPROVED | CHANGES_REQUESTED (a new version is a new row)
// Snag:    OPEN → FIXED (franchisee, with a photo) → CLOSED (staff verify) | back to OPEN
//          OPEN | FIXED → WAIVED (staff, with a reason)

export const SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;
export const DESIGN_TASK = "DESIGN";
export const FITOUT_TASK = "FITOUT";
/** Photos further than this from the site's pin are flagged. */
export const FAR_FROM_SITE_M = 500;

const byRowid = (a: Row, b: Row) => String(b.ROWID).localeCompare(String(a.ROWID), undefined, { numeric: true });

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function projectSite(repo: TenantRepo, project: Row): Promise<Row | null> {
  return project.site_id ? repo.findOne("sites", { ROWID: String(project.site_id) }) : null;
}

/** Everything on the construction panel: designs (newest first), photos, snags and the opening gate. */
export async function constructionFor(store: Store, ctx: TenantContext, project: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const [designs, photos, snags, site] = await Promise.all([
    repo.findMany("design_reviews", { project_id: pid }, { limit: 300 }),
    repo.findMany("site_photos", { project_id: pid }, { orderBy: "ROWID", desc: true, limit: 300 }),
    repo.findMany("snags", { project_id: pid }, { limit: 300 }),
    projectSite(repo, project),
  ]);
  designs.sort(byRowid);
  const approved = designs.find((d) => d.status === "APPROVED") ?? null;
  const open = snags.filter((s) => s.status === "OPEN" || s.status === "FIXED");
  const blocking = open.filter((s) => s.severity !== "MINOR");
  const sevRank = (s: Row) => SEVERITIES.indexOf(String(s.severity) as (typeof SEVERITIES)[number]);
  const stRank: Record<string, number> = { OPEN: 0, FIXED: 1, CLOSED: 2, WAIVED: 3 };
  snags.sort((a, b) => (stRank[String(a.status)] ?? 9) - (stRank[String(b.status)] ?? 9) || sevRank(b) - sevRank(a) || toNum(a.snag_no) - toNum(b.snag_no));
  return {
    design: { current: designs[0] ?? null, approved, history: designs },
    photos, site_pin: site && toNumOrNull(site.latitude) !== null ? { latitude: toNum(site.latitude), longitude: toNum(site.longitude) } : null,
    snags,
    snag_counts: { open: snags.filter((s) => s.status === "OPEN").length, fixed: snags.filter((s) => s.status === "FIXED").length, blocking: blocking.length, total: snags.length },
  };
}

// ---- Design approval ----

export async function submitDesign(store: Store, ctx: TenantContext, project: Row, input: { title: string; notes?: string | null; file_ref: string }, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const all = await repo.findMany("design_reviews", { project_id: pid }, { limit: 300 });
  if (all.some((d) => d.status === "SUBMITTED")) throw new AppError("INVALID_TRANSITION", "A design is already waiting for review. Wait for the decision before sending another version.");
  const version = all.reduce((m, d) => Math.max(m, toNum(d.version)), 0) + 1;
  const row = await repo.insert("design_reviews", {
    project_id: pid, franchisee_id: project.franchisee_id ?? null, version, title: input.title, notes: input.notes ?? null, file_ref: input.file_ref,
    status: "SUBMITTED", submitted_by: ctx.userId ?? null, submitted_at: now.toISOString(),
  });
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: "design:submitted", metadata: { project_id: pid, design_id: String(row.ROWID), version, title: input.title } });
  return row;
}

export async function decideDesign(store: Store, ctx: TenantContext, project: Row, design: Row, decision: "APPROVED" | "CHANGES_REQUESTED", note: string | null, now: Date): Promise<Row> {
  if (design.status !== "SUBMITTED") throw new AppError("INVALID_TRANSITION", "This design has already been decided.");
  if (decision === "CHANGES_REQUESTED" && !note) throw new AppError("VALIDATION_FAILED", "Say what needs to change.", { note: "required" });
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("design_reviews", String(design.ROWID), { status: decision, reviewed_by: ctx.userId ?? null, reviewed_at: now.toISOString(), review_note: note });
  const pid = String(project.ROWID);
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: decision === "APPROVED" ? "design:approved" : "design:changes", metadata: { project_id: pid, design_id: String(design.ROWID), version: design.version, note } });
  return row;
}

/** Fit-out can't be marked done until a design is approved. */
export async function assertDesignApproved(store: Store, ctx: TenantContext, projectId: string): Promise<void> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const approved = await repo.findOne("design_reviews", { project_id: projectId, status: "APPROVED" });
  if (!approved) throw new AppError("VALIDATION_FAILED", "Fit-out can't be marked done before the store design is approved.", { design: "not approved" });
}

// ---- Site photos ----

export interface PhotoInput { file_ref: string; caption?: string | null; area?: string | null; taken_at?: string | null; latitude?: number | null; longitude?: number | null; accuracy_m?: number | null }

export async function addPhoto(store: Store, ctx: TenantContext, project: Row, input: PhotoInput, source: "PORTAL" | "STAFF", now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const site = await projectSite(repo, project);
  const located = input.latitude != null && input.longitude != null;
  const dist = located && site && toNumOrNull(site.latitude) !== null ? distanceM(input.latitude!, input.longitude!, toNum(site.latitude), toNum(site.longitude)) : null;
  // A photo can't be taken in the future; a missing time means "now".
  const taken = input.taken_at && Date.parse(input.taken_at) <= now.getTime() ? new Date(input.taken_at).toISOString() : now.toISOString();
  const row = await repo.insert("site_photos", {
    project_id: String(project.ROWID), file_ref: input.file_ref, caption: input.caption ?? null, area: input.area ?? null, taken_at: taken,
    latitude: located ? input.latitude : null, longitude: located ? input.longitude : null, accuracy_m: located ? input.accuracy_m ?? null : null,
    distance_m: dist, uploaded_by: ctx.userId ?? null, source,
  });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "photo:added", metadata: { project_id: String(project.ROWID), photo_id: String(row.ROWID), area: input.area ?? null, located, distance_m: dist } });
  return row;
}

// ---- Snags ----

export async function raiseSnag(store: Store, ctx: TenantContext, project: Row, input: { title: string; area?: string | null; severity: (typeof SEVERITIES)[number]; due_date?: string | null; photo_ref?: string | null }, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const existing = await repo.findMany("snags", { project_id: pid }, { limit: 300 });
  const snag_no = existing.reduce((m, s) => Math.max(m, toNum(s.snag_no)), 0) + 1;
  const row = await repo.insert("snags", {
    project_id: pid, franchisee_id: project.franchisee_id ?? null, snag_no, title: input.title, area: input.area ?? null, severity: input.severity,
    status: "OPEN", due_date: input.due_date ?? null, photo_ref: input.photo_ref ?? null, raised_by: ctx.userId ?? null, raised_at: now.toISOString(),
  });
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: "snag:raised", metadata: { project_id: pid, snag_id: String(row.ROWID), snag_no, title: input.title, severity: input.severity } });
  return row;
}

export type SnagAction = { action: "fix"; note?: string | null; photo_ref?: string | null } | { action: "close" } | { action: "reopen"; note: string } | { action: "waive"; note: string };

export async function changeSnag(store: Store, ctx: TenantContext, project: Row, snag: Row, change: SnagAction, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const at = now.toISOString();
  const from = String(snag.status);
  const allowed: Record<string, string[]> = { fix: ["OPEN"], close: ["FIXED"], reopen: ["FIXED", "CLOSED"], waive: ["OPEN", "FIXED"] };
  if (!allowed[change.action].includes(from)) throw new AppError("INVALID_TRANSITION", `A ${from.toLowerCase()} snag can't be ${change.action === "fix" ? "marked fixed" : `${change.action}d`}.`);
  const patch: Row =
    change.action === "fix" ? { status: "FIXED", fix_note: change.note ?? null, fix_photo_ref: change.photo_ref ?? null, fixed_by: ctx.userId ?? null, fixed_at: at }
    : change.action === "close" ? { status: "CLOSED", closed_by: ctx.userId ?? null, closed_at: at }
    : change.action === "reopen" ? { status: "OPEN", close_note: change.note, closed_by: null, closed_at: null }
    : { status: "WAIVED", close_note: change.note, closed_by: ctx.userId ?? null, closed_at: at };
  const row = await repo.update("snags", String(snag.ROWID), patch);
  const pid = String(project.ROWID);
  const verb = { fix: "fixed", close: "closed", reopen: "reopened", waive: "waived" }[change.action];
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: `snag:${verb}`, metadata: { project_id: pid, snag_id: String(snag.ROWID), snag_no: snag.snag_no, title: snag.title, severity: snag.severity, from, note: "note" in change ? change.note ?? null : null } });
  return row;
}

/** Major and critical snags still open or awaiting verification stop the store opening. */
export async function assertSnagsCleared(store: Store, ctx: TenantContext, projectId: string): Promise<void> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const open = (await repo.findMany("snags", { project_id: projectId }, { limit: 300 }))
    .filter((s) => (s.status === "OPEN" || s.status === "FIXED") && s.severity !== "MINOR")
    .sort((a, b) => toNum(a.snag_no) - toNum(b.snag_no));
  if (!open.length) return;
  throw new AppError("SNAGS_OPEN", `The store can't open with ${open.length} major or critical snag${open.length === 1 ? "" : "s"} not cleared: ${open.slice(0, 5).map((s) => `#${s.snag_no} ${s.title}`).join(", ")}${open.length > 5 ? "…" : ""}.`,
    Object.fromEntries(open.map((s) => [`snag_${s.snag_no}`, s.status === "FIXED" ? "fixed, not verified" : "open"])));
}
