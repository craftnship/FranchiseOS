import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { addStaff, decideTraining, markLeft, metTasks, MODULE_CODES, recordTraining, setPlan, STAFF_ROLES, staffingFor, updateStaff } from "../../workflows/staffing";
import { Call, parse, Router } from "../router";
import { assertOwner, completeTasks, mustGet, signedUrl, storeUpload, uploadSchema } from "./shared";

// Hiring and training on an opening project. The franchisee (portal) adds the people they hire and
// records their training; staff with project.write (project and training managers) set the plan,
// sign training off or send it back, and can record either themselves.

const text = (max: number) => z.string().trim().max(max);
const day = z.string().date();
const phone = z.string().trim().regex(/^[+0-9 ()-]{6,20}$/, "Enter a phone number.");
const planSchema = z.object(Object.fromEntries(STAFF_ROLES.map((r) => [r, z.number().int().min(0).max(100).optional()]))).strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change.");
const staffSchema = z.object({
  full_name: text(120).min(2), role_code: z.enum(STAFF_ROLES), phone: phone.nullish(), email: z.string().trim().email().max(200).nullish(),
  hired_on: day, start_date: day.nullish(),
}).strict();
const staffChangeSchema = z.union([
  z.object({ action: z.literal("leave"), left_on: day, reason: text(500).nullish() }).strict(),
  z.object({ full_name: text(120).min(2).optional(), role_code: z.enum(STAFF_ROLES).optional(), phone: phone.nullish(), email: z.string().trim().email().max(200).nullish(), start_date: day.nullish() }).strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to change."),
]);
const trainingSchema = z.object({
  module_code: z.enum(MODULE_CODES), completed_on: day, score: z.number().min(0).max(100).nullish(), trainer: text(120).nullish(), certificate: uploadSchema.optional(),
}).strict();
const decisionSchema = z.object({ decision: z.enum(["SIGNED_OFF", "RETURNED"]), note: text(1000).nullish() }).strict();

const getProject = async (call: Call) => assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
async function child(call: Call, table: string, id: string): Promise<Row> {
  const r = await mustGet(call.repo, table, id, "NOT_FOUND");
  if (String(r.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return r;
}
const portalOrStaff = async (call: Call) => { if (!isPortalUser(call.ctx)) await authorize(call.ctx, "project.write", call.permissions); };
const notClosed = (p: Row) => { if (p.status === "CLOSED") throw new AppError("INVALID_TRANSITION", "This project is closed."); };
const notFuture = (call: Call, d: string, field: string) => { if (d > call.now.toISOString().slice(0, 10)) throw new AppError("VALIDATION_FAILED", "The date can't be in the future.", { [field]: "can't be in the future" }); };

/** Completes the hiring and training tasks the team now meets. */
async function syncTasks(call: Call, project: Row): Promise<string[]> {
  return completeTasks(call, project, await metTasks(call.store, call.ctx, project));
}

export function staffingRoutes(r: Router): void {
  r.on("GET", "/projects/:id/staffing", null, async (call) => staffingFor(call.store, call.ctx, await getProject(call)));

  r.on("PATCH", "/projects/:id/staffing/plan", "project.write", async (call) => {
    const project = await getProject(call);
    notClosed(project);
    const updated = await setPlan(call.store, call.ctx, project, parse(planSchema, call.body));
    return { ...(await staffingFor(call.store, call.ctx, updated)), tasks_completed: await syncTasks(call, updated) };
  });

  r.on("POST", "/projects/:id/staff", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call); notClosed(project);
    const b = parse(staffSchema, call.body);
    notFuture(call, b.hired_on, "hired_on");
    const row = await addStaff(call.store, call.ctx, project, b, isPortalUser(call.ctx) ? "PORTAL" : "STAFF");
    return { ...row, tasks_completed: await syncTasks(call, project) };
  }, 201);

  r.on("PATCH", "/projects/:id/staff/:staffId", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call); notClosed(project);
    const person = await child(call, "store_staff", call.params.staffId);
    const b = parse(staffChangeSchema, call.body);
    if ("action" in b) {
      notFuture(call, b.left_on, "left_on");
      return markLeft(call.store, call.ctx, project, person, b.left_on, b.reason ?? null);
    }
    const row = await updateStaff(call.store, call.ctx, project, person, b);
    return { ...row, tasks_completed: await syncTasks(call, project) };
  });

  r.on("POST", "/projects/:id/staff/:staffId/training", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call); notClosed(project);
    const person = await child(call, "store_staff", call.params.staffId);
    const { certificate, ...b } = parse(trainingSchema, call.body);
    notFuture(call, b.completed_on, "completed_on");
    const certificate_ref = certificate ? await storeUpload(call, `projects/${call.params.id}/training`, certificate) : null;
    const row = await recordTraining(call.store, call.ctx, project, person, { ...b, certificate_ref }, isPortalUser(call.ctx) ? "PORTAL" : "STAFF", call.now);
    return { ...row, tasks_completed: row.status === "SIGNED_OFF" ? await syncTasks(call, project) : [] };
  }, 201);

  r.on("POST", "/projects/:id/training/:trainingId/decision", "project.write", async (call) => {
    const project = await getProject(call);
    const b = parse(decisionSchema, call.body);
    const row = await decideTraining(call.store, call.ctx, project, await child(call, "staff_training", call.params.trainingId), b.decision, b.note ?? null, call.now);
    return { ...row, tasks_completed: row.status === "SIGNED_OFF" ? await syncTasks(call, project) : [] };
  });

  r.on("GET", "/projects/:id/training/:trainingId/certificate", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await child(call, "staff_training", call.params.trainingId)).certificate_ref ?? ""), "No certificate attached.");
  });
}
