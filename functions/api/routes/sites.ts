import { z } from "zod";
import { AppError } from "../../common/errors";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toBool, toNum } from "../../common/values";
import { DEFAULT_SITE_TEMPLATE, scoreSite, TemplateItem } from "../../scoring/site";
import { allowedTransitions, findRule, transitionsFrom } from "../../workflows/stateMachines";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { assertOwner, defined, mustGet, ownerFilter, signedUrl, storeUpload, uploadSchema } from "./shared";
import { assertLeaseSigned, describeLease, LEASE_STATES, leaseForSite, saveLease } from "../../workflows/leases";
import { leaseNotices } from "../../workflows/notifications";
import { listInRegion } from "./regions";

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

const money = z.number().nonnegative().max(1e10).nullable().optional();
const months = z.number().int().min(0).max(600).nullable().optional();
const leaseSchema = z.object({
  landlord_name: z.string().trim().max(200).nullable().optional(),
  landlord_contact: z.string().trim().max(200).nullable().optional(),
  monthly_rent: money, cam_monthly: money, security_deposit: money,
  escalation_pct: z.number().min(0).max(100).nullable().optional(),
  escalation_every_months: z.number().int().min(1).max(120).nullable().optional(),
  lease_start: z.string().date().nullable().optional(),
  term_months: months, lock_in_months: months,
  rent_free_days: z.number().int().min(0).max(730).nullable().optional(),
  renewal_notice_days: z.number().int().min(0).max(730).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(LEASE_STATES).optional(),
  signed_on: z.string().date().nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

/** Sites whose lease can be recorded: from evaluation on, until rejected or dropped. */
const LEASE_SITE_STATES = ["FEASIBILITY", "APPROVAL_PENDING", "APPROVED", "LEASE_PENDING", "LEASE_SIGNED", "READY_FOR_PROJECT"];

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

const DEAD_SITE = ["REJECTED", "DROPPED"];

export function siteRoutes(r: Router): void {
  r.on("GET", "/sites", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional(), application_id: z.string().optional() }), call.query);
    const where = { ...(q.application_id ? { application_id: q.application_id } : {}), ...ownerFilter(call) };
    return listInRegion(call, "sites", q.status, where, q, (s) => (row) => s.applicationId(row.application_id));
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
    } else if (["SITE_SUBMITTED", "FEASIBILITY_REVIEW"].includes(String(app.status))) {
      // A replacement for a rejected or dropped site takes its place; feasibility is redone for it.
      const current = app.site_id ? await call.repo.findOne("sites", { ROWID: String(app.site_id) }) : null;
      if (!current || DEAD_SITE.includes(String(current.status))) {
        await call.repo.update("franchise_applications", String(app.ROWID), { site_id: String(site.ROWID), feasibility_id: null });
        await logActivity(call.store, call.ctx, { entityType: "application", entityId: String(app.ROWID), action: "site:replaced", metadata: { from: current ? String(current.ROWID) : null, to: String(site.ROWID) } });
      }
    }
    return site;
  }, 201);

  r.on("GET", "/sites/:id", null, async (call) => {
    const site = await getSite(call);
    const evaluations = isPortalUser(call.ctx) ? [] : await call.repo.findMany("site_evaluations", { site_id: String(site.ROWID) }, { orderBy: "CREATEDTIME", desc: true, limit: 20 });
    const transitions = transitionsFrom("site", String(site.status))
      .filter((t) => !t.permission?.startsWith("system.") && !["evaluated", "approve"].includes(t.transition));
    const evaluation_template = isPortalUser(call.ctx) ? [] : (await siteTemplate(call)).items;
    const lease = await describeLease(call.store, call.ctx, await leaseForSite(call.store, call.ctx, String(site.ROWID)), String(site.ROWID), call.now.toISOString().slice(0, 10));
    return { ...site, evaluations, allowed_transitions: allowedTransitions("site", String(site.status)), transitions, evaluation_template, lease };
  });

  // Lease terms; signing needs the signed document and moves the site to lease signed.
  const leaseSave = async (call: Call, change: Parameters<typeof saveLease>[3]) => {
    const site = await getSite(call);
    if (!LEASE_SITE_STATES.includes(String(site.status))) throw new AppError("INVALID_TRANSITION", `A site in ${site.status} has no lease to record.`);
    if (change.status === "SIGNED" && !["APPROVED", "LEASE_PENDING", "LEASE_SIGNED", "READY_FOR_PROJECT"].includes(String(site.status))) {
      throw new AppError("INVALID_TRANSITION", "Approve the site before signing its lease.");
    }
    const projects = (await call.zoho().catch(() => null))?.projects ?? null;
    const today = call.now.toISOString().slice(0, 10);
    const r = await saveLease(call.store, call.ctx, site, change, { today, now: call.now, projects, permissions: call.permissions, onTransition: call.onTransition });
    await leaseNotices(call.store, call.ctx, r.lease, call.now);
    return { ...r, lease: await describeLease(call.store, call.ctx, r.lease, String(site.ROWID), today) };
  };

  r.on("PATCH", "/sites/:id/lease", "site.write", async (call) => leaseSave(call, parse(leaseSchema, call.body)));

  r.on("POST", "/sites/:id/lease/document", "site.write", async (call) => {
    const file_ref = await storeUpload(call, `sites/${call.params.id}/lease`, parse(uploadSchema, call.body));
    return leaseSave(call, { file_ref });
  }, 201);

  r.on("GET", "/sites/:id/lease/document", null, async (call) => {
    const site = await getSite(call);
    return signedUrl(call, String((await leaseForSite(call.store, call.ctx, String(site.ROWID)))?.file_ref ?? ""), "No lease document uploaded.");
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
    if (transition === "lease_signed") await assertLeaseSigned(call.store, call.ctx, String(site.ROWID));
    const row = await transitionEntity("site", String(site.ROWID), transition, call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
    if (comments) await logActivity(call.store, call.ctx, { entityType: "site", entityId: String(site.ROWID), action: "comment", metadata: { transition, comments } });
    return row;
  });
}
