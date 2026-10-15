import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { AUDIT_TYPES, auditDetail, auditsFor, cancelAudit, completeAudit, itemsOf, networkAudits, recordItems, reviewAction, rescheduleAudit, respondAction, scheduleAudit, startAudit } from "../../workflows/audits";
import { Call, parse, Router } from "../router";
import { assertOwner, mustGet, PORTAL_ROLES, signedUrl, staffDirectory, storeUpload, uploadSchema } from "./shared";
import { regionScope } from "./regions";
import { toNum } from "../../common/values";

// Store audits. audit.conduct books, runs and completes audits and closes corrective actions; the
// franchisee sees finished audits of their own store and answers its actions with evidence.

const text = (max: number) => z.string().trim().max(max);
const day = z.string().date();
const scheduleSchema = z.object({ audit_type: z.enum(AUDIT_TYPES), planned_for: day, auditor_user_id: z.string().min(1).nullish(), notes: text(1000).nullish() }).strict();
const itemSchema = z.object({ code: text(60).min(1), verdict: z.enum(["PASS", "FAIL", "NA"]).nullable(), comments: text(1000).nullish(), photo: uploadSchema.optional() }).strict();
const auditChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("save"), items: z.array(itemSchema).min(1).max(60) }).strict(),
  z.object({ action: z.literal("complete"), summary: text(2000).nullish() }).strict(),
  z.object({ action: z.literal("reschedule"), planned_for: day, auditor_user_id: z.string().min(1).nullish() }).strict(),
  z.object({ action: z.literal("cancel"), reason: text(500).min(3) }).strict(),
]);
const actionChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("respond"), note: text(2000).min(3), evidence: uploadSchema.optional() }).strict(),
  z.object({ action: z.literal("close"), note: text(1000).nullish() }).strict(),
  z.object({ action: z.literal("reopen"), note: text(1000).min(3), due_date: day.nullish() }).strict(),
]);

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const getProject = async (call: Call) => await assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");

/** An audit the caller may see: staff with audit.conduct or dashboard.view; the franchisee only a finished one of their own. */
async function getAudit(call: Call): Promise<Row> {
  const audit = await assertOwner(call, await mustGet(call.repo, "audits", call.params.auditId, "NOT_FOUND"), "NOT_FOUND");
  if (isPortalUser(call.ctx)) { if (audit.status !== "COMPLETED") throw new AppError("NOT_FOUND"); return audit; }
  try { await authorize(call.ctx, "audit.conduct", call.permissions); } catch { await authorize(call.ctx, "dashboard.view", call.permissions); }
  return audit;
}

export function auditRoutes(r: Router): void {
  r.on("GET", "/projects/:id/audits", null, async (call) => auditsFor(call.store, call.ctx, await getProject(call), today(call), isPortalUser(call.ctx)));

  r.on("POST", "/projects/:id/audits", "audit.conduct", async (call) => scheduleAudit(call.store, call.ctx, await getProject(call), parse(scheduleSchema, call.body)), 201);

  // Network view, and the staff an audit can be given to.
  r.on("GET", "/audits", "dashboard.view", async (call) => {
    const scope = await regionScope(call);
    const all = await networkAudits(call.store, call.ctx, today(call));
    if (!scope.region) return all;
    // The store list and its totals follow the region; the most-failed standards stay network-wide.
    const stores = (all.stores as Row[]).filter((x) => scope.projectId(x.project_id));
    const scored = stores.filter((x) => x.last_score != null);
    const totals = all.totals as Row;
    return {
      ...all, stores,
      totals: {
        ...totals, stores: stores.length, audited: scored.length,
        average: scored.length ? Math.round(scored.reduce((a, x) => a + toNum(x.last_score), 0) / scored.length * 10) / 10 : null,
        red: scored.filter((x) => x.last_rating === "RED").length, due: stores.filter((x) => x.due_overdue).length,
        actions_open: stores.reduce((a, x) => a + toNum(x.actions_open), 0), actions_overdue: stores.reduce((a, x) => a + toNum(x.actions_overdue), 0),
      },
    };
  });
  r.on("GET", "/audits/auditors", "audit.conduct", async (call) =>
    [...(await staffDirectory(call)).values()].filter((p) => p.active && !PORTAL_ROLES.includes(p.role)).map(({ ROWID, name, email }) => ({ ROWID, name: name ?? email })).sort((a, b) => a.name.localeCompare(b.name)));

  r.on("GET", "/audits/:auditId", null, async (call) => auditDetail(call.store, call.ctx, await getAudit(call), today(call)));

  r.on("PATCH", "/audits/:auditId", "audit.conduct", async (call) => {
    const audit = await mustGet(call.repo, "audits", call.params.auditId, "NOT_FOUND");
    const b = parse(auditChangeSchema, call.body);
    switch (b.action) {
      case "start": return (await startAudit(call.store, call.ctx, audit, call.now)).audit;
      case "save": {
        const items = [];
        for (const { photo, ...x } of b.items) items.push({ ...x, evidence_ref: photo ? await storeUpload(call, `audits/${audit.ROWID}`, photo) : null });
        return { items: await recordItems(call.store, call.ctx, audit, items) };
      }
      case "complete": {
        const project = await mustGet(call.repo, "franchise_projects", String(audit.project_id), "NOT_FOUND");
        return completeAudit(call.store, call.ctx, audit, project, b.summary ?? null, call.now);
      }
      case "reschedule":
        if (b.planned_for < today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the past.", { planned_for: "in the past" });
        return rescheduleAudit(call.store, call.ctx, audit, b);
      case "cancel": return cancelAudit(call.store, call.ctx, audit, b.reason);
    }
  });

  r.on("GET", "/audits/:auditId/items/:code/photo", null, async (call) => {
    const audit = await getAudit(call);
    const item = (await itemsOf(call.repo, audit)).find((i) => i.code === call.params.code);
    return signedUrl(call, String(item?.evidence_ref ?? ""), "No photo for this standard.");
  });

  // respond: the franchisee (or audit.conduct for them); close and reopen: audit.conduct.
  r.on("PATCH", "/corrective-actions/:actionId", null, async (call) => {
    const action = await assertOwner(call, await mustGet(call.repo, "corrective_actions", call.params.actionId, "NOT_FOUND"), "NOT_FOUND");
    const b = parse(actionChangeSchema, call.body);
    const portal = isPortalUser(call.ctx);
    if (portal && b.action !== "respond") throw new AppError("ACCESS_DENIED", "The auditor closes corrective actions.");
    if (!portal) await authorize(call.ctx, "audit.conduct", call.permissions);
    if (b.action === "respond") {
      const evidence_ref = b.evidence ? await storeUpload(call, `audits/${action.audit_id}/actions`, b.evidence) : null;
      return respondAction(call.store, call.ctx, action, { note: b.note, evidence_ref }, portal ? "PORTAL" : "STAFF", call.now);
    }
    if (b.action === "reopen" && b.due_date && b.due_date < today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the past.", { due_date: "in the past" });
    return reviewAction(call.store, call.ctx, action, { accept: b.action === "close", note: b.note ?? null, due_date: b.action === "reopen" ? b.due_date ?? null : null }, call.now);
  });

  r.on("GET", "/corrective-actions/:actionId/evidence", null, async (call) => {
    const action = await assertOwner(call, await mustGet(call.repo, "corrective_actions", call.params.actionId, "NOT_FOUND"), "NOT_FOUND");
    return signedUrl(call, String(action.evidence_ref ?? ""), "No evidence attached.");
  });
}
