import { AppError } from "../common/errors";
import { Mailer, TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { log } from "../common/logger";
import { Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { ZohoProjectsClient } from "../integrations/clients";
import { calculateReadiness, ChecklistItem, DEFAULT_READINESS_WEIGHTS, ReadinessResult } from "../scoring/readiness";
import { Weighted } from "../scoring/weights";
import { syncProjectTasks } from "./projectSync";
import { transitionEntity, TransitionDeps } from "./transition";

// Readiness and project risk (plan Step 6.1-6.2, FOS-058, spec §20, §22 job_project_risk).

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

/** Projects the risk job still watches. */
export const ACTIVE_PROJECT_STATES = ["PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];

/**
 * Pace-based risk: a project is judged on whether it is keeping up, not on how much is done, so a new
 * project on schedule is LOW. Blockers (mandatory items blocked or overdue) make it HIGH, any overdue
 * item MEDIUM. Close to opening, low readiness counts too: RED within 14 days is HIGH, and anything
 * short of GREEN within 30 days is at least MEDIUM.
 */
export function riskLevel(r: Pick<ReadinessResult, "rag" | "blockers" | "overdue">, daysToOpening: number | null = null): RiskLevel {
  const near = (days: number) => daysToOpening !== null && daysToOpening <= days;
  if (r.blockers.length || (near(14) && r.rag === "RED")) return "HIGH";
  if (r.overdue.length || (near(30) && r.rag !== "GREEN")) return "MEDIUM";
  return "LOW";
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso.slice(0, 10)) - Date.parse(fromIso.slice(0, 10))) / 86_400_000);
}

export function tenantReadinessWeights(tenant: Row | null): Weighted[] {
  try {
    const s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {};
    if (Array.isArray(s.readiness_weights) && s.readiness_weights.length) return s.readiness_weights as Weighted[];
  } catch { /* fall back to defaults */ }
  return DEFAULT_READINESS_WEIGHTS;
}

function toItem(r: Row): ChecklistItem {
  const status = String(r.status) as ChecklistItem["status"];
  return { id: String(r.ROWID), category: String(r.category), weight: r.weight == null ? 1 : toNum(r.weight), mandatory: toBool(r.mandatory), status, due_date: r.due_date ? String(r.due_date).slice(0, 10) : null };
}

export interface ProjectReadiness extends ReadinessResult {
  project_id: string;
  risk_level: RiskLevel;
  /** The checklist rows behind blockers and overdue ids, for the UI. */
  blocker_items: Row[];
  overdue_items: Row[];
}

/** Computes readiness from the opening checklist without writing anything. */
export async function computeReadiness(store: Store, ctx: TenantContext, projectId: string, today: string): Promise<ProjectReadiness> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const project = await repo.findOne("franchise_projects", { ROWID: projectId });
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  const rows = await repo.findMany("opening_checklists", { project_id: projectId }, { limit: 300 });
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const result = calculateReadiness(rows.map(toItem), today, tenantReadinessWeights(tenant));
  const byId = new Map(rows.map((r) => [String(r.ROWID), r]));
  return {
    ...result,
    project_id: projectId,
    risk_level: riskLevel(result, project.target_opening_date ? daysBetween(today, String(project.target_opening_date)) : null),
    blocker_items: result.blockers.map((id) => byId.get(id)!),
    overdue_items: result.overdue.map((id) => byId.get(id)!),
  };
}

/**
 * Recomputes readiness, stores it on the project with a snapshot, and moves an in-progress project
 * to AT_RISK when it has blockers (and back when they clear).
 */
export async function refreshReadiness(
  store: Store,
  ctx: TenantContext,
  projectId: string,
  args: { today: string; now?: Date } & Pick<TransitionDeps, "onTransition">,
): Promise<ProjectReadiness & { status: string }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const r = await computeReadiness(store, ctx, projectId, args.today);
  let project = await repo.update("franchise_projects", projectId, { readiness_score: r.score, readiness_rag: r.rag, risk_level: r.risk_level });
  await repo.insert("readiness_snapshots", {
    project_id: projectId, score: r.score, rag: r.rag, blockers: r.blockers.length, overdue: r.overdue.length,
    taken_at: (args.now ?? new Date()).toISOString(),
  });
  const deps = { store, permissions: async () => new Set(["system.project"]), onTransition: args.onTransition };
  if (project.status === "IN_PROGRESS" && r.blockers.length) {
    project = await transitionEntity("project", projectId, "flag_risk", ctx, deps);
  } else if (project.status === "AT_RISK" && !r.blockers.length) {
    project = await transitionEntity("project", projectId, "clear_risk", ctx, deps);
  }
  return { ...r, status: String(project.status) };
}

/**
 * job_project_risk (daily): for every active project of every active tenant, pull task progress from
 * Zoho Projects (when connected), then refresh readiness. One project's failure never stops the run.
 */
export async function runProjectRiskJob(
  store: Store,
  projectsFor: (tenantId: string) => Promise<ZohoProjectsClient | null>,
  opts: { today: string; now?: Date; requestId: string; mailer?: Mailer },
): Promise<{ projects: number; synced: number; at_risk: number; failed: number }> {
  const out = { projects: 0, synced: 0, at_risk: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId, mailer: opts.mailer };
    const repo = new TenantRepo(store, tenantId);
    const projects = await projectsFor(tenantId).catch(() => null);
    for (const state of ACTIVE_PROJECT_STATES) {
      for (const p of await repo.findMany("franchise_projects", { status: state }, { limit: 300 })) {
        out.projects++;
        try {
          if (projects && p.zoho_project_id) { await syncProjectTasks(store, ctx, projects, String(p.ROWID)); out.synced++; }
          const r = await refreshReadiness(store, ctx, String(p.ROWID), { today: opts.today, now: opts.now });
          if (r.status === "AT_RISK" || r.risk_level === "HIGH") out.at_risk++;
        } catch (e) {
          out.failed++;
          log("warn", "job.project_risk_failed", { tenant_id: tenantId, request_id: opts.requestId, project_id: String(p.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
        }
      }
    }
  }
  log("info", "job.project_risk", { request_id: opts.requestId, ...out });
  return out;
}

/** Flags or unflags a checklist item as blocked (D-7); Zoho has no blocked state, so FOS owns it. */
export async function setChecklistBlocked(store: Store, ctx: TenantContext, projectId: string, itemId: string, blocked: boolean, reason?: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const item = await repo.findOne("opening_checklists", { ROWID: itemId, project_id: projectId });
  if (!item) throw new AppError("NOT_FOUND", "Checklist item not found.");
  if (item.status === "COMPLETED") throw new AppError("INVALID_TRANSITION", "A completed item cannot be blocked.");
  const updated = await repo.update("opening_checklists", itemId, { status: blocked ? "BLOCKED" : "OPEN" });
  await logActivity(store, ctx, { entityType: "checklist", entityId: itemId, action: blocked ? "checklist:blocked" : "checklist:unblocked", metadata: { project_id: projectId, reason: reason ?? null } });
  return updated;
}

export interface ChecklistChange { done?: boolean; owner_user_id?: string | null; due_date?: string }

/**
 * Marks a checklist item done or reopens it, assigns its owner, or moves its due date. Zoho Projects
 * stays the source of truth for task progress, so for a linked task the change is made there first
 * and nothing is written in FOS if Zoho refuses it; the next sync then agrees with FOS.
 */
export async function updateChecklistItem(
  store: Store, ctx: TenantContext, projects: ZohoProjectsClient | null, projectId: string, itemId: string, change: ChecklistChange,
): Promise<{ item: Row; zoho: boolean }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const project = await repo.findOne("franchise_projects", { ROWID: projectId });
  const item = await repo.findOne("opening_checklists", { ROWID: itemId, project_id: projectId });
  if (!project || !item) throw new AppError("NOT_FOUND", "Checklist item not found.");
  const wasDone = item.status === "COMPLETED";
  const status = change.done === undefined || change.done === wasDone ? undefined : change.done ? "COMPLETED" : "OPEN";
  const due = change.due_date && change.due_date !== String(item.due_date ?? "").slice(0, 10) ? change.due_date : undefined;

  const linked = !!(project.zoho_project_id && item.external_task_id);
  if (linked && (status || due)) {
    if (!projects) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Projects is not connected, so the task can't be updated there.");
    const zp = String(project.zoho_project_id), task = String(item.external_task_id);
    try {
      if (status) await projects.setTaskClosed(zp, task, status === "COMPLETED");
      if (due) await projects.rescheduleTask(zp, task, due);
    } catch (e) {
      log("warn", "checklist.zoho_update_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, item_id: itemId, error: String((e as Error)?.message ?? e).slice(0, 300) });
      throw new AppError("ZOHO_SYNC_FAILED", `Zoho Projects didn't accept the change: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  const patch: Row = {
    // Zoho's own status name is refreshed by the next sync; until then the FOS status speaks for it.
    ...(status ? { status, ...(linked ? { external_status: null } : {}) } : {}),
    ...(due ? { due_date: due } : {}),
    ...(change.owner_user_id !== undefined ? { owner_user_id: change.owner_user_id } : {}),
  };
  const updated = Object.keys(patch).length ? await repo.update("opening_checklists", itemId, patch) : item;
  const action = status === "COMPLETED" ? "checklist:completed" : status ? "checklist:reopened" : "checklist:updated";
  if (Object.keys(patch).length) await logActivity(store, ctx, { entityType: "checklist", entityId: itemId, action, metadata: { project_id: projectId, ...patch, zoho: linked && !!(status || due) } });
  return { item: updated, zoho: linked && !!(status || due) };
}
