import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { Row, Store, TenantRepo } from "../common/store";
import { logActivity } from "../common/audit";
import { toBool } from "../common/values";
import { ZohoProjectsClient } from "../integrations/clients";

// Opening project creation (spec §15, FOS-053..056). Every external call is checkpointed in
// Data Store, so a rerun resumes from the first unfinished step and never recreates the project.

export interface TemplateTask {
  code: string;
  name: string;
  category: string; // readiness category; also the Zoho task list name
  mandatory: boolean;
  weight?: number;
  offset_days: number; // due date relative to project start
  depends_on?: string[];
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function buildOpeningProject(
  store: Store,
  ctx: TenantContext,
  projects: ZohoProjectsClient,
  args: { projectRowId: string; template: TemplateTask[]; startDate: string; /** false keeps dependencies local only (default true). */ dependencies?: boolean },
): Promise<{ zohoProjectId: string; tasksCreated: number; dependenciesCreated: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const project = await repo.findOne("franchise_projects", { ROWID: args.projectRowId });
  if (!project) throw new AppError("PROJECT_CREATION_FAILED", "Project record not found.");

  // 1. Zoho project (once).
  let zohoProjectId = project.zoho_project_id as string | null;
  if (!zohoProjectId) {
    const ref = await projects.createProject({ name: `${project.project_code} Opening`, start_date: args.startDate, end_date: project.target_opening_date as string });
    zohoProjectId = ref.id;
    await repo.update("franchise_projects", args.projectRowId, { zoho_project_id: zohoProjectId });
  }

  // 2. Local checklist rows from the template (once), so readiness works even before tasks sync.
  const existing = await repo.findMany("opening_checklists", { project_id: args.projectRowId }, { limit: 300 });
  const byCode = new Map(existing.map((r) => [String(r.task_code), r]));
  for (const t of args.template) {
    if (byCode.has(t.code)) continue;
    const row = await repo.insert("opening_checklists", {
      project_id: args.projectRowId,
      task_code: t.code,
      category: t.category,
      item: t.name,
      weight: t.weight ?? 1,
      mandatory: t.mandatory,
      status: "OPEN",
      due_date: addDays(args.startDate, t.offset_days),
      depends_on_json: JSON.stringify(t.depends_on ?? []),
      external_task_id: null,
      external_tasklist_id: null,
      dependencies_synced: false,
    });
    byCode.set(t.code, row);
  }

  // 3. Task lists, one per category (reuse IDs already recorded on any row of that category).
  const tasklistIds = new Map<string, string>();
  for (const r of byCode.values()) if (r.external_tasklist_id) tasklistIds.set(String(r.category), String(r.external_tasklist_id));
  for (const category of new Set(args.template.map((t) => t.category))) {
    if (tasklistIds.has(category)) continue;
    const ref = await projects.createTaskList(zohoProjectId, { name: category });
    tasklistIds.set(category, ref.id);
    for (const r of byCode.values()) {
      if (r.category === category) {
        await repo.update("opening_checklists", String(r.ROWID), { external_tasklist_id: ref.id });
        r.external_tasklist_id = ref.id;
      }
    }
  }

  // 4. Tasks: only rows without an external id. A failure here leaves earlier tasks intact.
  let tasksCreated = 0;
  for (const r of byCode.values()) {
    if (r.external_task_id) continue;
    const ref = await projects.createTask(zohoProjectId, { name: String(r.item), tasklist_id: tasklistIds.get(String(r.category))!, end_date: String(r.due_date) });
    await repo.update("opening_checklists", String(r.ROWID), { external_task_id: ref.id });
    r.external_task_id = ref.id;
    tasksCreated++;
  }

  // 5. Dependencies: per successor row, flagged when done. Skipped while the tenant's Projects
  // adapter cannot create them; depends_on_json still drives readiness.
  let dependenciesCreated = 0;
  for (const r of args.dependencies === false ? [] : byCode.values()) {
    if (toBool(r.dependencies_synced)) continue;
    const deps = JSON.parse(String(r.depends_on_json || "[]")) as string[];
    for (const code of deps) {
      const pred = byCode.get(code);
      if (!pred) throw new AppError("PROJECT_CREATION_FAILED", `Template dependency ${code} not found.`);
      await projects.addDependency(zohoProjectId, String(pred.external_task_id), String(r.external_task_id));
      dependenciesCreated++;
    }
    await repo.update("opening_checklists", String(r.ROWID), { dependencies_synced: true });
  }

  if (project.status === "NOT_STARTED") await repo.update("franchise_projects", args.projectRowId, { status: "PLANNING" });
  await logActivity(store, ctx, { entityType: "project", entityId: args.projectRowId, action: "project:built", metadata: { zohoProjectId, tasksCreated, dependenciesCreated } });
  return { zohoProjectId, tasksCreated, dependenciesCreated };
}

export type { Row };
