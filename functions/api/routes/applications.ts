import { z } from "zod";
import { AppError } from "../../common/errors";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { isPortalUser, authorize } from "../../common/rbac";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { DEFAULT_QUALIFICATION_WEIGHTS, DEFAULT_THRESHOLDS, scoreQualification, territoryAvailabilityRating } from "../../scoring/qualification";
import { startApproval } from "../../workflows/approvals";
import { allowedTransitions, findRule } from "../../workflows/stateMachines";
import { transitionEntity } from "../../workflows/transition";
import { DEFAULT_APPROVAL_WORKFLOW, DEFAULT_REQUIRED_DOCUMENTS } from "../../../database/seed/defaults";
import { Call, page, parse, Router } from "../router";
import { assertOwner, defined, listByStatus, mustGet, ownerFilter, settings } from "./shared";

const editable = {
  application_type: z.enum(["UNIT", "MULTI_UNIT", "MASTER", "AREA_DEVELOPER"]).optional(),
  preferred_country: z.string().trim().max(60).optional(),
  preferred_state: z.string().trim().max(60).optional(),
  preferred_city: z.string().trim().max(60).optional(),
  investment_capacity: z.number().nonnegative().optional(),
};
const createSchema = z.object({ franchisee_id: z.string().min(1).optional(), zoho_lead_id: z.string().max(50).optional(), ...editable }).strict();
const patchSchema = z.object(editable).strict();
const documentSchema = z.object({
  document_type: z.string().trim().min(1).max(50),
  file_ref: z.string().trim().min(1).max(500),
  document_number: z.string().trim().max(100).optional(),
  issue_date: z.string().date().optional(),
  expiry_date: z.string().date().optional(),
}).strict();
const verifySchema = z.object({ verification_status: z.enum(["VERIFIED", "REJECTED"]), rejection_reason: z.string().trim().max(1000).optional() }).strict()
  .refine((b) => b.verification_status !== "REJECTED" || !!b.rejection_reason, { message: "A reason is required.", path: ["rejection_reason"] });
const scoreSchema = z.object({ ratings: z.record(z.number().min(0).max(100)) }).strict();
const transitionSchema = z.object({ transition: z.string().min(1).max(40) }).strict();

const EDITABLE_STATES = ["DRAFT", "UNDER_REVIEW", "ON_HOLD"];

async function getApp(call: Call): Promise<Row> {
  return assertOwner(call, await mustGet(call.repo, "franchise_applications", call.params.id, "APPLICATION_NOT_FOUND"), "APPLICATION_NOT_FOUND");
}

/** Mandatory documents must be uploaded and not rejected before submit (FOS-018). */
async function requireDocuments(call: Call, app: Row): Promise<void> {
  const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
  const required = (settings(tenant).required_documents as string[] | undefined) ?? DEFAULT_REQUIRED_DOCUMENTS;
  const docs = await call.repo.findMany("application_documents", { application_id: String(app.ROWID) });
  const present = new Set(docs.filter((d) => d.verification_status !== "REJECTED").map((d) => String(d.document_type)));
  const missing = required.filter((t) => !present.has(t));
  if (missing.length) throw new AppError("APPLICATION_DOCUMENT_MISSING", "Required documents are missing.", Object.fromEntries(missing.map((m) => [m, "required"])));
}

export function applicationRoutes(r: Router): void {
  r.on("GET", "/applications", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional(), franchisee_id: z.string().optional() }), call.query);
    const where = { ...(q.franchisee_id ? { franchisee_id: q.franchisee_id } : {}), ...ownerFilter(call) };
    return listByStatus(call.repo, "franchise_applications", q.status, where, q);
  });

  // Staff create for any franchisee; a portal user creates one for their own franchisee only.
  r.on("POST", "/applications", null, async (call) => {
    const body = parse(createSchema, call.body);
    let franchiseeId = body.franchisee_id;
    if (isPortalUser(call.ctx)) {
      await authorize(call.ctx, "application.submit", call.permissions);
      franchiseeId = ownerFilter(call).franchisee_id;
    } else {
      await authorize(call.ctx, "application.review", call.permissions);
    }
    if (!franchiseeId) throw new AppError("VALIDATION_FAILED", "franchisee_id is required.", { franchisee_id: "required" });
    await mustGet(call.repo, "franchisees", franchiseeId, "FRANCHISEE_NOT_FOUND");
    const application_code = await nextBusinessId(call.store, call.ctx.tenantId, "application");
    const row = await call.repo.insert("franchise_applications", {
      ...body, franchisee_id: franchiseeId, application_code, tenant_code_key: `${call.ctx.tenantId}:${application_code}`,
      status: "DRAFT", owner_user_id: isPortalUser(call.ctx) ? null : call.ctx.userId,
    });
    await logActivity(call.store, call.ctx, { entityType: "application", entityId: String(row.ROWID), action: "create" });
    return row;
  }, 201);

  r.on("GET", "/applications/:id", null, async (call) => {
    const app = await getApp(call);
    const documents = await call.repo.findMany("application_documents", { application_id: String(app.ROWID) });
    const allowed_transitions = allowedTransitions("application", String(app.status));
    return { ...app, documents, allowed_transitions };
  });

  r.on("PATCH", "/applications/:id", null, async (call) => {
    const body = parse(patchSchema, call.body);
    const app = await getApp(call);
    await authorize(call.ctx, isPortalUser(call.ctx) ? "application.submit" : "application.review", call.permissions);
    const allowed = isPortalUser(call.ctx) ? ["DRAFT"] : EDITABLE_STATES;
    if (!allowed.includes(String(app.status))) throw new AppError("APPLICATION_INVALID_STATE", `An application in ${app.status} cannot be edited.`);
    const row = await call.repo.update("franchise_applications", call.params.id, defined(body));
    await logActivity(call.store, call.ctx, { entityType: "application", entityId: call.params.id, action: "update", metadata: { fields: Object.keys(body) } });
    return row;
  });

  r.on("POST", "/applications/:id/documents", null, async (call) => {
    const body = parse(documentSchema, call.body);
    const app = await getApp(call);
    await authorize(call.ctx, isPortalUser(call.ctx) ? "application.submit" : "application.review", call.permissions);
    const row = await call.repo.insert("application_documents", { ...body, application_id: String(app.ROWID), verification_status: "PENDING" });
    await logActivity(call.store, call.ctx, { entityType: "application", entityId: String(app.ROWID), action: "document:add", metadata: { document_type: body.document_type } });
    return row;
  }, 201);

  r.on("POST", "/applications/:id/documents/:docId/verify", "application.review", async (call) => {
    const body = parse(verifySchema, call.body);
    await getApp(call);
    const doc = await mustGet(call.repo, "application_documents", call.params.docId, "NOT_FOUND");
    if (String(doc.application_id) !== call.params.id) throw new AppError("NOT_FOUND");
    const row = await call.repo.update("application_documents", call.params.docId, { ...body, verified_by: call.ctx.userId });
    await logActivity(call.store, call.ctx, { entityType: "application", entityId: call.params.id, action: `document:${body.verification_status.toLowerCase()}`, metadata: { document_id: call.params.docId } });
    return row;
  });

  r.on("POST", "/applications/:id/submit", null, async (call) => {
    const app = await getApp(call);
    return transitionEntity("application", String(app.ROWID), "submit", call.ctx, {
      store: call.store, onTransition: call.onTransition, permissions: call.permissions,
      businessRules: { application: (entity) => requireDocuments(call, entity as Row) },
    });
  });

  // Qualification scoring (§18). D-10: territory availability is derived from the preferred city when not rated.
  r.on("POST", "/applications/:id/score", "application.review", async (call) => {
    const body = parse(scoreSchema, call.body);
    const app = await getApp(call);
    if (!["SUBMITTED", "UNDER_REVIEW", "QUALIFIED"].includes(String(app.status))) {
      throw new AppError("APPLICATION_INVALID_STATE", `An application in ${app.status} cannot be scored.`);
    }
    const ratings = { ...body.ratings };
    if (ratings.territory_availability === undefined && app.preferred_city) {
      const territories = await call.repo.findMany("territories", { city: String(app.preferred_city) });
      ratings.territory_availability = territoryAvailabilityRating(territories.map((t) => String(t.status)));
    }
    const { weights, thresholds } = await qualificationConfig(call);
    const result = scoreQualification(ratings, weights, thresholds);
    const row = await call.repo.update("franchise_applications", String(app.ROWID), {
      qualification_score: result.score, qualification_class: result.classification, score_breakdown_json: JSON.stringify(result.breakdown),
    });
    await logActivity(call.store, call.ctx, { entityType: "application", entityId: String(app.ROWID), action: "score", metadata: { score: result.score, class: result.classification } });
    return { ...row, breakdown: result.breakdown };
  });

  // Generic user-driven transitions (start_review, qualify, require_site, hold, resume, withdraw, reject…).
  // Engine-driven transitions (system.*) are never reachable from the API.
  r.on("POST", "/applications/:id/transition", null, async (call) => {
    const { transition } = parse(transitionSchema, call.body);
    const app = await getApp(call);
    const rule = findRule("application", String(app.status), transition);
    if (rule?.permission.startsWith("system.") || transition === "submit" || transition === "start_approval") {
      throw new AppError("INVALID_TRANSITION", `Use the dedicated endpoint for ${transition}.`);
    }
    return transitionEntity("application", String(app.ROWID), transition, call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
  });

  r.on("POST", "/applications/:id/start-approval", "approval.start", async (call) => {
    const app = await getApp(call);
    if (!app.feasibility_id) throw new AppError("VALIDATION_FAILED", "Feasibility is required.", { feasibility_id: "required" });
    const feas = await mustGet(call.repo, "feasibility_models", String(app.feasibility_id), "FEASIBILITY_NOT_FOUND");
    if (feas.status !== "CALCULATED") throw new AppError("FEASIBILITY_NOT_FOUND", "Feasibility has not been calculated.");
    if (feas.passed !== true && String(feas.passed) !== "true") throw new AppError("FEASIBILITY_FAILED", "Feasibility did not meet the thresholds.");
    const site = app.site_id ? await call.repo.findOne("sites", { ROWID: String(app.site_id) }) : null;

    const updated = await transitionEntity("application", String(app.ROWID), "start_approval", call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
    try {
      const approval = await startApproval(call.store, call.ctx, {
        entityType: "application", entityId: String(app.ROWID), workflowCode: DEFAULT_APPROVAL_WORKFLOW.code, now: call.now,
        facts: {
          initial_investment: toNum(feas.initial_investment), roi_pct: toNum(feas.roi_pct), payback_months: feas.payback_months,
          qualification_score: toNum(app.qualification_score), site_score: site ? toNum(site.site_score) : null, application_type: app.application_type,
        },
      });
      return { application: updated, approval };
    } catch (e) {
      // Keep status and approval consistent: undo the status change if the approval could not start.
      await call.repo.update("franchise_applications", String(app.ROWID), { status: app.status });
      throw e;
    }
  });
}

async function qualificationConfig(call: Call) {
  const templates = await call.repo.findMany("qualification_templates", { status: "ACTIVE" }, { orderBy: "version", desc: true, limit: 1 });
  const t = templates[0];
  if (!t) return { weights: DEFAULT_QUALIFICATION_WEIGHTS, thresholds: DEFAULT_THRESHOLDS };
  const items = await call.repo.findMany("qualification_template_items", { template_id: String(t.ROWID) });
  return {
    weights: items.length ? items.map((i) => ({ code: String(i.code), weight: toNum(i.weight) })) : DEFAULT_QUALIFICATION_WEIGHTS,
    thresholds: { hot: toNum(t.hot_threshold), qualified: toNum(t.qualified_threshold), nurture: toNum(t.nurture_threshold) },
  };
}

