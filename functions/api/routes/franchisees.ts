import { z } from "zod";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { page, parse, Router } from "../router";
import { assertOwner, defined, mustGet, ownerFilter } from "./shared";

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
    const where = { ...ownerFilter(call, "ROWID"), ...(q.status ? { status: q.status } : {}) };
    return call.repo.findMany("franchisees", where, { orderBy: "CREATEDTIME", desc: true, limit: q.limit, offset: q.offset });
  });

  r.on("POST", "/franchisees", "application.review", async (call) => {
    const body = parse(createSchema, call.body);
    const franchise_code = await nextBusinessId(call.store, call.ctx.tenantId, "franchisee");
    const row = await call.repo.insert("franchisees", {
      ...body, franchise_code, tenant_code_key: `${call.ctx.tenantId}:${franchise_code}`, status: "PROSPECT",
    });
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: String(row.ROWID), action: "create" });
    return row;
  }, 201);

  r.on("GET", "/franchisees/:id", null, async (call) =>
    assertOwner(call, await mustGet(call.repo, "franchisees", call.params.id, "FRANCHISEE_NOT_FOUND"), "FRANCHISEE_NOT_FOUND", "ROWID"));

  r.on("PATCH", "/franchisees/:id", "application.review", async (call) => {
    const body = parse(patchSchema, call.body);
    await mustGet(call.repo, "franchisees", call.params.id, "FRANCHISEE_NOT_FOUND");
    const row = await call.repo.update("franchisees", call.params.id, defined(body));
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: call.params.id, action: "update", metadata: { fields: Object.keys(body) } });
    return row;
  });
}
