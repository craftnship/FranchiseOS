import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
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

export function riskLevel(r: Pick<ReadinessResult, "rag" | "blockers" | "overdue">): RiskLevel {
  if (r.rag === "RED" || r.blockers.length) return "HIGH";
  if (r.rag === "AMBER" || r.overdue.length) return "MEDIUM";
  return "LOW";
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
    risk_level: riskLevel(result),
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
  opts: { today: string; now?: Date; requestId: string },
): Promise<{ projects: number; synced: number; at_risk: number; failed: number }> {
  const out = { projects: 0, synced: 0, at_risk: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId };
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
