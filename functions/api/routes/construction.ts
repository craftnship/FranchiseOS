import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { addPhoto, changeSnag, constructionFor, decideDesign, DESIGN_TASK, raiseSnag, SEVERITIES, submitDesign } from "../../workflows/construction";
import { Call, parse, Router } from "../router";
import { assertOwner, completeTasks, mustGet, signedUrl, storeUpload, uploadSchema } from "./shared";

// Construction: design approval, site photos and snags on an opening project. The franchisee (portal)
// submits designs, adds photos and fixes snags; staff with project.write decide designs and raise,
// verify or waive snags.

const text = (max: number) => z.string().trim().max(max);
const designSchema = z.object({ title: text(200).min(2), notes: text(2000).nullish(), file: uploadSchema }).strict();
const decisionSchema = z.object({ decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]), note: text(1000).nullish() }).strict();
const photoSchema = z.object({
  file: uploadSchema, caption: text(300).nullish(), area: text(60).nullish(), taken_at: z.string().datetime({ offset: true }).nullish(),
  latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(), accuracy_m: z.number().min(0).max(100_000).nullish(),
}).strict();
const snagSchema = z.object({ title: text(300).min(3), area: text(60).nullish(), severity: z.enum(SEVERITIES).default("MINOR"), due_date: z.string().date().nullish(), photo: uploadSchema.optional() }).strict();
const snagChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fix"), note: text(1000).nullish(), photo: uploadSchema.optional() }).strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("reopen"), note: text(1000).min(3) }).strict(),
  z.object({ action: z.literal("waive"), note: text(1000).min(3) }).strict(),
]);

const getProject = async (call: Call) => assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
async function child(call: Call, table: string, id: string): Promise<Row> {
  const r = await mustGet(call.repo, table, id, "NOT_FOUND");
  if (String(r.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return r;
}
const staffOnly = (call: Call) => authorize(call.ctx, "project.write", call.permissions);
/** Portal users, or staff who can change the project. */
const portalOrStaff = async (call: Call) => { if (!isPortalUser(call.ctx)) await staffOnly(call); };
const notClosed = (p: Row) => { if (p.status === "CLOSED") throw new AppError("INVALID_TRANSITION", "This project is closed."); };

export function constructionRoutes(r: Router): void {
  r.on("GET", "/projects/:id/construction", null, async (call) => constructionFor(call.store, call.ctx, await getProject(call)));

  r.on("POST", "/projects/:id/designs", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call); notClosed(project);
    const b = parse(designSchema, call.body);
    const file_ref = await storeUpload(call, `projects/${call.params.id}/design`, b.file);
    return submitDesign(call.store, call.ctx, project, { title: b.title, notes: b.notes, file_ref }, call.now);
  }, 201);

  r.on("POST", "/projects/:id/designs/:designId/decision", "project.write", async (call) => {
    const project = await getProject(call);
    const b = parse(decisionSchema, call.body);
    const row = await decideDesign(call.store, call.ctx, project, await child(call, "design_reviews", call.params.designId), b.decision, b.note ?? null, call.now);
    // Approval completes the "Get store design approved" task, in Zoho Projects too when linked.
    const task = b.decision === "APPROVED" ? await completeTasks(call, project, [DESIGN_TASK]) : [];
    return { ...row, task_completed: task.length > 0 };
  });

  r.on("GET", "/projects/:id/designs/:designId/file", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await child(call, "design_reviews", call.params.designId)).file_ref ?? ""), "No drawing attached.");
  });

  r.on("POST", "/projects/:id/photos", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call); notClosed(project);
    const { file, ...b } = parse(photoSchema, call.body);
    if (!file.content_type.startsWith("image/")) throw new AppError("VALIDATION_FAILED", "Upload a JPG, PNG or WebP photo.", { file: "not an image" });
    const file_ref = await storeUpload(call, `projects/${call.params.id}/photos`, file);
    return addPhoto(call.store, call.ctx, project, { ...b, file_ref }, isPortalUser(call.ctx) ? "PORTAL" : "STAFF", call.now);
  }, 201);

  r.on("GET", "/projects/:id/photos/:photoId/file", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await child(call, "site_photos", call.params.photoId)).file_ref ?? ""), "Photo not found.");
  });

  r.on("POST", "/projects/:id/snags", "project.write", async (call) => {
    const project = await getProject(call);
    notClosed(project);
    const { photo, ...b } = parse(snagSchema, call.body);
    const photo_ref = photo ? await storeUpload(call, `projects/${call.params.id}/snags`, photo) : null;
    return raiseSnag(call.store, call.ctx, project, { ...b, photo_ref }, call.now);
  }, 201);

  // Fix (franchisee or staff); close, reopen and waive (staff).
  r.on("PATCH", "/projects/:id/snags/:snagId", null, async (call) => {
    const project = await getProject(call);
    const b = parse(snagChangeSchema, call.body);
    if (b.action === "fix") await portalOrStaff(call); else { if (isPortalUser(call.ctx)) throw new AppError("ACCESS_DENIED", "The franchise team verifies snags."); await staffOnly(call); }
    const snag = await child(call, "snags", call.params.snagId);
    if (b.action === "fix") {
      const photo_ref = b.photo ? await storeUpload(call, `projects/${call.params.id}/snags`, b.photo) : null;
      return changeSnag(call.store, call.ctx, project, snag, { action: "fix", note: b.note, photo_ref }, call.now);
    }
    return changeSnag(call.store, call.ctx, project, snag, b, call.now);
  });

  r.on("GET", "/projects/:id/snags/:snagId/photo", null, async (call) => {
    await getProject(call);
    const s = await child(call, "snags", call.params.snagId);
    const which = call.query.which === "fix" ? s.fix_photo_ref : s.photo_ref;
    return signedUrl(call, String(which ?? ""), "No photo attached.");
  });
}
