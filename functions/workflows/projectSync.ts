import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { Store, TenantRepo } from "../common/store";
import { ZohoProjectsClient } from "../integrations/clients";

// Project task sync (plan Step 5.4, FOS-057): Zoho Projects is the source of truth for task
// progress; opening_checklists mirrors it for readiness. BLOCKED is set in FOS only, so a still-open
// Zoho task never clears it.

export function checklistStatus(task: { closed: boolean; percent?: number }, current: string): string {
  if (task.closed) return "COMPLETED";
  if (current === "BLOCKED") return "BLOCKED";
  // A reopened task, or one with progress, counts as in progress.
  return (task.percent ?? 0) > 0 || current === "COMPLETED" || current === "IN_PROGRESS" ? "IN_PROGRESS" : "OPEN";
}

export async function syncProjectTasks(
  store: Store,
  ctx: TenantContext,
  projects: ZohoProjectsClient,
  projectRowId: string,
): Promise<{ checked: number; updated: number; missing: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const project = await repo.findOne("franchise_projects", { ROWID: projectRowId });
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  if (!project.zoho_project_id) throw new AppError("PROJECT_CREATION_FAILED", "The Zoho project has not been created yet.");
  const tasks = new Map((await projects.listTasks(String(project.zoho_project_id))).map((t) => [t.id, t]));
  const rows = await repo.findMany("opening_checklists", { project_id: projectRowId }, { limit: 300 });
  let updated = 0;
  let missing = 0;
  for (const r of rows) {
    const t = r.external_task_id ? tasks.get(String(r.external_task_id)) : undefined;
    if (!t) { missing++; continue; }
    const next = checklistStatus(t, String(r.status));
    if (next !== r.status) {
      await repo.update("opening_checklists", String(r.ROWID), { status: next });
      updated++;
    }
  }
  return { checked: rows.length, updated, missing };
}
