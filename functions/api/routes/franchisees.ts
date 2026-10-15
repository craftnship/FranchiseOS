import { defaultFranchiseType } from "../../common/franchiseType";
import { z } from "zod";
import { AppError } from "../../common/errors";
import { pullFranchiseeContact } from "../../workflows/crmContacts";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { page, parse, Router } from "../router";
import { allowed, isPortalUser } from "../../common/rbac";
import { franchiseeOverview } from "../../workflows/franchiseeOverview";
import { assertOwner, defined, mustGet, ownerFilter, staffCan } from "./shared";
import { listInRegion } from "./regions";

const fields = {
  display_name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().max(200).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(30).optional(),
  franchise_type: z.string().trim().max(50).optional(),
  zoho_lead_id: z.string().trim().max(50).optional(),
};
const createSchema = z.object(fields).strict();
const patchSchema = z.object({ ...fields, display_name: fields.display_name.optional(), status: z.enum(["PROSPECT", "ACTIVE", "INACTIVE"]).optional() }).strict();

export function franchiseeRoutes(r: Router): void {
  r.on("GET", "/franchisees", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional() }), call.query);
    return listInRegion(call, "franchisees", q.status, ownerFilter(call, "ROWID"), q, (s) => s.franchisee);
  });

  r.on("POST", "/franchisees", "application.review", async (call) => {
    const body = parse(createSchema, call.body);
    const franchise_code = await nextBusinessId(call.store, call.ctx.tenantId, "franchisee");
    const row = await call.repo.insert("franchisees", {
      ...body, franchise_type: body.franchise_type || defaultFranchiseType(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })),
      franchise_code, tenant_code_key: `${call.ctx.tenantId}:${franchise_code}`, status: "PROSPECT",
    });
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: String(row.ROWID), action: "create" });
    return row;
  }, 201);

  r.on("GET", "/franchisees/:id", null, async (call) =>
    await assertOwner(call, await mustGet(call.repo, "franchisees", call.params.id, "FRANCHISEE_NOT_FOUND"), "FRANCHISEE_NOT_FOUND", "ROWID"));

  // The record page: everything about one partner across their applications, agreements and stores.
  // Portal users see their own partner only; money needs finance.view.
  r.on("GET", "/franchisees/:id/overview", null, async (call) => {
    const franchisee = await assertOwner(call, await mustGet(call.repo, "franchisees", call.params.id, "FRANCHISEE_NOT_FOUND"), "FRANCHISEE_NOT_FOUND", "ROWID");
    await staffCan(call, "dashboard.view", "application.review");
    const portal = isPortalUser(call.ctx);
    const finance = portal || await allowed(call.ctx, "finance.view", call.permissions);
    return franchiseeOverview(call.store, call.ctx, franchisee, { today: call.now.toISOString().slice(0, 10), finance, portal });
  });

  // Copies contact details edited in CRM (lead, or Contact and Account after signing) now.
  r.on("POST", "/franchisees/:id/sync-crm", "application.review", async (call) => {
    const franchisee = await mustGet(call.repo, "franchisees", call.params.id, "NOT_FOUND");
    const crm = (await call.zoho())?.crm;
    if (!crm) throw new AppError("ZOHO_SYNC_FAILED", "Zoho CRM is not connected for this tenant.");
    const changed = await pullFranchiseeContact(call.store, call.ctx, crm, franchisee);
    return { changed, franchisee: changed.length ? await mustGet(call.repo, "franchisees", call.params.id, "NOT_FOUND") : franchisee };
  });

  r.on("PATCH", "/franchisees/:id", "application.review", async (call) => {
    const body = parse(patchSchema, call.body);
    await mustGet(call.repo, "franchisees", call.params.id, "FRANCHISEE_NOT_FOUND");
    const row = await call.repo.update("franchisees", call.params.id, defined(body));
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: call.params.id, action: "update", metadata: { fields: Object.keys(body) } });
    return row;
  });
}
