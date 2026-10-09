import { z } from "zod";
import { AppError } from "../../common/errors";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toBool, toNum } from "../../common/values";
import { DEFAULT_SITE_TEMPLATE, scoreSite, TemplateItem } from "../../scoring/site";
import { allowedTransitions, findRule } from "../../workflows/stateMachines";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { assertOwner, defined, mustGet, ownerFilter } from "./shared";

const editable = {
  address_line_1: z.string().trim().max(300).optional(),
  city: z.string().trim().max(60).optional(),
  state: z.string().trim().max(60).optional(),
  postal_code: z.string().trim().max(20).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  area_sqft: z.number().positive().optional(),
  rent: z.number().nonnegative().optional(),
  deposit: z.number().nonnegative().optional(),
};
const createSchema = z.object({ application_id: z.string().min(1), ...editable, city: z.string().trim().min(1).max(60) }).strict();
const patchSchema = z.object(editable).strict();
const evaluateSchema = z.object({
  ratings: z.record(z.number()),
  strengths: z.string().max(4000).optional(),
  risks: z.string().max(4000).optional(),
  photo_refs: z.array(z.string().max(500)).max(50).optional(),
  gps_lat: z.number().min(-90).max(90).optional(),
  gps_lng: z.number().min(-180).max(180).optional(),
}).strict();
const transitionSchema = z.object({ transition: z.string().min(1).max(40), comments: z.string().max(2000).optional() }).strict();

/** Site states in which address and commercials may still change. */
const EDITABLE_STATES = ["PROPOSED", "SCREENING", "SITE_VISIT", "EVALUATION"];

async function getSite(call: Call): Promise<Row> {
  return assertOwner(call, await mustGet(call.repo, "sites", call.params.id, "SITE_NOT_FOUND"), "SITE_NOT_FOUND");
}

async function siteTemplate(call: Call): Promise<{ id: string | null; items: TemplateItem[] }> {
  const t = (await call.repo.findMany("evaluation_templates", { status: "ACTIVE" }, { orderBy: "version", desc: true, limit: 1 }))[0];
  if (!t) return { id: null, items: DEFAULT_SITE_TEMPLATE };
  const rows = await call.repo.findMany("evaluation_template_items", { template_id: String(t.ROWID) });
  if (!rows.length) return { id: String(t.ROWID), items: DEFAULT_SITE_TEMPLATE };
  return {
    id: String(t.ROWID),
    items: rows.map((i) => ({ code: String(i.code), name: String(i.name), weight: toNum(i.weight), max_score: toNum(i.max_score), mandatory: toBool(i.mandatory) })),
  };
}

export function siteRoutes(r: Router): void {
  r.on("GET", "/sites", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional(), application_id: z.string().optional() }), call.query);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.application_id ? { application_id: q.application_id } : {}), ...ownerFilter(call) };
    return call.repo.findMany("sites", where, { orderBy: "CREATEDTIME", desc: true, limit: q.limit, offset: q.offset });
  });

  // Franchisees may propose sites for their own application; staff need site.write.
  r.on("POST", "/sites", null, async (call) => {
    const body = parse(createSchema, call.body);
    await authorize(call.ctx, isPortalUser(call.ctx) ? "application.submit" : "site.write", call.permissions);
    const app = assertOwner(call, await mustGet(call.repo, "franchise_applications", body.application_id, "APPLICATION_NOT_FOUND"), "APPLICATION_NOT_FOUND");
    if (!app.territory_id) throw new AppError("VALIDATION_FAILED", "The application has no reserved territory yet.", { territory_id: "required" });
    const site_code = await nextBusinessId(call.store, call.ctx.tenantId, "site");
    const site = await call.repo.insert("sites", {
      ...body, site_code, tenant_code_key: `${call.ctx.tenantId}:${site_code}`,
      franchisee_id: String(app.franchisee_id), territory_id: String(app.territory_id), status: "PROPOSED",
    });
    await logActivity(call.store, call.ctx, { entityType: "site", entityId: String(site.ROWID), action: "create", metadata: { application_id: body.application_id } });
    // First site on an application waiting for one moves it forward.
    if (app.status === "SITE_REQUIRED") {
      await call.repo.update("franchise_applications", String(app.ROWID), { site_id: String(site.ROWID) });
      await transitionEntity("application", String(app.ROWID), "site_submitted", call.ctx, { store: call.store, onTransition: call.onTransition, permissions: async () => new Set(["site.write"]) });
    }
    return site;
  }, 201);

  r.on("GET", "/sites/:id", null, async (call) => {
    const site = await getSite(call);
    const evaluations = isPortalUser(call.ctx) ? [] : await call.repo.findMany("site_evaluations", { site_id: String(site.ROWID) }, { orderBy: "CREATEDTIME", desc: true, limit: 20 });
    return { ...site, evaluations, allowed_transitions: allowedTransitions("site", String(site.status)) };
  });

  r.on("PATCH", "/sites/:id", "site.write", async (call) => {
    const body = parse(patchSchema, call.body);
    const site = await getSite(call);
    if (!EDITABLE_STATES.includes(String(site.status))) throw new AppError("INVALID_TRANSITION", `A site in ${site.status} cannot be edited.`);
    const row = await call.repo.update("sites", call.params.id, defined(body));
    await logActivity(call.store, call.ctx, { entityType: "site", entityId: call.params.id, action: "update", metadata: { fields: Object.keys(body) } });
    return row;
  });

  // Weighted site score (§17) with D-16 bands; the evaluation moves the site to FEASIBILITY.
  r.on("POST", "/sites/:id/evaluate", "site.evaluate", async (call) => {
    const body = parse(evaluateSchema, call.body);
    const site = await getSite(call);
    if (site.status !== "EVALUATION") throw new AppError("INVALID_TRANSITION", `A site in ${site.status} cannot be evaluated.`);
    const template = await siteTemplate(call);
    const { score, recommendation } = scoreSite(body.ratings, template.items);
    const evaluation = await call.repo.insert("site_evaluations", {
      site_id: String(site.ROWID), template_id: template.id, ratings_json: JSON.stringify(body.ratings), score, recommendation,
      strengths: body.strengths ?? null, risks: body.risks ?? null, photo_refs_json: JSON.stringify(body.photo_refs ?? []),
      gps_lat: body.gps_lat ?? null, gps_lng: body.gps_lng ?? null, evaluated_by: call.ctx.userId,
    });
    await call.repo.update("sites", String(site.ROWID), { site_score: score, recommendation });
    const updated = await transitionEntity("site", String(site.ROWID), "evaluated", call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
    return { site: updated, evaluation };
  });

  // D-6 sign-off on the site alone. A REJECT-band score cannot be approved.
  r.on("POST", "/sites/:id/approve", "site.approve", async (call) => {
    const site = await getSite(call);
    if (site.recommendation === "REJECT") throw new AppError("VALIDATION_FAILED", "Sites scored below 65 cannot be approved.", { site_score: "below threshold" });
    return transitionEntity("site", String(site.ROWID), "approve", call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
  });

  r.on("POST", "/sites/:id/transition", null, async (call) => {
    const { transition, comments } = parse(transitionSchema, call.body);
    const site = await getSite(call);
    if (transition === "evaluated" || transition === "approve") throw new AppError("INVALID_TRANSITION", `Use the dedicated endpoint for ${transition}.`);
    if (findRule("site", String(site.status), transition)?.permission.startsWith("system.")) throw new AppError("INVALID_TRANSITION");
    const row = await transitionEntity("site", String(site.ROWID), transition, call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
    if (comments) await logActivity(call.store, call.ctx, { entityType: "site", entityId: String(site.ROWID), action: "comment", metadata: { transition, comments } });
    return row;
  });
}
