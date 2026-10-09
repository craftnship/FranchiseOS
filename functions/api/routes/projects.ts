import { z } from "zod";
import { AppError } from "../../common/errors";
import { syncProjectTasks } from "../../workflows/projectSync";
import { page, parse, Router } from "../router";
import { assertOwner, mustGet, ownerFilter } from "./shared";

export function projectRoutes(r: Router): void {
  r.on("GET", "/projects", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional() }), call.query);
    const where = { ...(q.status ? { status: q.status } : {}), ...ownerFilter(call) };
    return call.repo.findMany("franchise_projects", where, { orderBy: "CREATEDTIME", desc: true, limit: q.limit, offset: q.offset });
  });

  r.on("GET", "/projects/:id", null, async (call) => {
    const project = assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
    const checklist = await call.repo.findMany("opening_checklists", { project_id: call.params.id }, { orderBy: "due_date", limit: 300 });
    return { ...project, checklist };
  });

  // Pulls task progress from Zoho Projects into the opening checklist.
  r.on("POST", "/projects/:id/sync", "project.write", async (call) => {
    await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND");
    const projects = (await call.zoho())?.projects;
    if (!projects) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Projects is not connected for this tenant.");
    return syncProjectTasks(call.store, call.ctx, projects, call.params.id);
  });
}
