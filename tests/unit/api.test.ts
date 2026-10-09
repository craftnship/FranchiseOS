import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { ApiRequest } from "../../functions/api/router";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { newStore } from "./helpers";

const router = buildRouter();
type Body = { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };

async function setup() {
  const store = newStore();
  const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark Industries", zohoDc: "IN" });
  const b = await bootstrapTenant(store, { tenantCode: "OTHER", name: "Other Co", zohoDc: "IN" });
  const addUser = async (tenant: typeof a, role: string, ext: string, franchiseeId?: string) =>
    store.insert("users", { tenant_id: tenant.tenantId, email: `${ext}@x.test`, status: "ACTIVE", role_id: tenant.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  for (const [role, ext] of [["FRANCHISE_MANAGER", "mgr"], ["FRANCHISE_DIRECTOR", "dir"], ["FINANCE_MANAGER", "fin"], ["LEGAL_MANAGER", "legal"]]) await addUser(a, role, ext);
  await addUser(b, "FRANCHISE_DIRECTOR", "other-dir");
  const call = async (ext: string | null, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const req: ApiRequest = { method, path: `/api/v1${path}`, body, query, identity: ext ? { externalUserId: ext, email: `${ext}@x.test` } : null };
    const res = await router.handle(req, { store });
    return { status: res.status, ...(res.body as Body) };
  };
  return { store, a, b, addUser, call };
}

const ratings = { financial_capacity: 90, business_experience: 80, industry_experience: 70, investment_readiness: 85, time_commitment: 90, profile_quality: 80 };
const siteRatings = { location: 9, footfall: 8, visibility: 8, competition: 7, rent: 8, demographics: 8, parking: 7, accessibility: 8 };
const feasibility = { initial_investment: 4_000_000, monthly_revenue: 1_200_000, gross_margin_pct: 65, monthly_fixed_opex: 400_000, royalty_pct: 6, marketing_fund_pct: 2 };

describe("tenant bootstrap", () => {
  it("is idempotent", async () => {
    const store = newStore();
    const first = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    const second = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    expect(first.created).toBeGreaterThan(50);
    expect(second.created).toBe(0);
    expect(second.roleIds).toEqual(first.roleIds);
    expect(await store.findMany("approval_workflow_steps", { tenant_id: first.tenantId })).toHaveLength(4);
  });
});

describe("api platform", () => {
  it("rejects unauthenticated calls and unknown users", async () => {
    const { call } = await setup();
    expect((await call(null, "GET", "/applications")).error?.code).toBe("AUTH_REQUIRED");
    expect((await call("nobody", "GET", "/applications")).status).toBe(403);
  });

  it("returns 404 for unknown routes and enforces role permissions", async () => {
    const { call } = await setup();
    expect((await call("mgr", "GET", "/nope")).status).toBe(404);
    const denied = await call("legal", "POST", "/franchisees", { display_name: "X" });
    expect(denied.error?.code).toBe("ACCESS_DENIED");
  });

  it("validates bodies field by field", async () => {
    const { call } = await setup();
    const res = await call("mgr", "POST", "/franchisees", { display_name: "", email: "bad" });
    expect(res.status).toBe(422);
    expect(Object.keys(res.error!.fields!)).toEqual(expect.arrayContaining(["display_name", "email"]));
  });

  it("never shows one tenant's records to another", async () => {
    const { call } = await setup();
    const f = await call("mgr", "POST", "/franchisees", { display_name: "Tony" });
    expect((await call("other-dir", "GET", `/franchisees/${f.data.ROWID}`)).error?.code).toBe("FRANCHISEE_NOT_FOUND");
    expect((await call("other-dir", "GET", "/franchisees")).data).toHaveLength(0);
  });
});

describe("franchise pipeline through the API", () => {
  it("runs lead to approved application", async () => {
    const { store, a, addUser, call } = await setup();

    const fr = await call("mgr", "POST", "/franchisees", { display_name: "Pepper Potts", email: "pepper@x.test" });
    expect(fr.status).toBe(201);
    expect(fr.data.franchise_code).toBe("FR-000001");
    await addUser(a, "FRANCHISEE", "pepper", String(fr.data.ROWID));

    // Portal user creates and fills their own application.
    const app = await call("pepper", "POST", "/applications", { application_type: "UNIT" });
    expect(app.status).toBe(201);
    const id = String(app.data.ROWID);
    await call("pepper", "PATCH", `/applications/${id}`, { preferred_city: "Chennai", investment_capacity: 5_000_000 });

    const missing = await call("pepper", "POST", `/applications/${id}/submit`);
    expect(missing.error?.code).toBe("APPLICATION_DOCUMENT_MISSING");
    for (const t of ["ID_PROOF", "ADDRESS_PROOF", "BANK_STATEMENT"]) {
      expect((await call("pepper", "POST", `/applications/${id}/documents`, { document_type: t, file_ref: `stratus://docs/${t}` })).status).toBe(201);
    }
    expect((await call("pepper", "POST", `/applications/${id}/submit`)).data.status).toBe("SUBMITTED");
    expect((await call("pepper", "PATCH", `/applications/${id}`, { preferred_city: "Pune" })).error?.code).toBe("APPLICATION_INVALID_STATE");

    // Another franchisee cannot see it.
    const other = await call("mgr", "POST", "/franchisees", { display_name: "Happy" });
    await addUser(a, "FRANCHISEE", "happy", String(other.data.ROWID));
    expect((await call("happy", "GET", `/applications/${id}`)).error?.code).toBe("APPLICATION_NOT_FOUND");
    expect((await call("happy", "GET", "/applications")).data).toHaveLength(0);

    // Review and score; territory availability is derived from Chennai (D-10).
    const ter = await call("mgr", "POST", "/territories", { name: "Chennai Central", city: "Chennai", franchise_type: "QSR", population_index: 80, market_index: 70, income_index: 60, competition_index: 40 });
    expect(ter.data.opportunity_score).toBeGreaterThan(0);
    await call("mgr", "POST", `/applications/${id}/transition`, { transition: "start_review" });
    const scored = await call("mgr", "POST", `/applications/${id}/score`, { ratings });
    expect(scored.data.qualification_class).toBe("HOT");
    expect((await call("mgr", "POST", `/applications/${id}/transition`, { transition: "qualify" })).data.status).toBe("QUALIFIED");

    // Reserve, then site.
    const found = await call("mgr", "POST", "/territories/search", { city: "Chennai" });
    expect(found.data).toHaveLength(1);
    expect((await call("mgr", "POST", `/territories/${ter.data.ROWID}/reserve`, { application_id: id })).data.status).toBe("ACTIVE");
    await call("mgr", "POST", `/applications/${id}/transition`, { transition: "require_site" });
    const site = await call("pepper", "POST", "/sites", { application_id: id, city: "Chennai", address_line_1: "1 Anna Salai", rent: 150000 });
    expect(site.status).toBe(201);
    const siteId = String(site.data.ROWID);
    expect((await call("mgr", "GET", `/applications/${id}`)).data.status).toBe("SITE_SUBMITTED");
    for (const t of ["screen", "schedule_visit", "start_evaluation"]) await call("mgr", "POST", `/sites/${siteId}/transition`, { transition: t });
    const ev = await call("mgr", "POST", `/sites/${siteId}/evaluate`, { ratings: siteRatings });
    expect(ev.data.site.status).toBe("FEASIBILITY");
    expect(ev.data.evaluation.recommendation).toBe("RECOMMEND");
    await call("mgr", "POST", `/sites/${siteId}/transition`, { transition: "request_signoff" });
    expect((await call("dir", "POST", `/sites/${siteId}/approve`)).data.status).toBe("APPROVED");

    // Feasibility.
    const fm = await call("fin", "POST", "/feasibility", { application_id: id, ...feasibility });
    expect(fm.status).toBe(201);
    expect((await call("mgr", "GET", `/applications/${id}`)).data.status).toBe("FEASIBILITY_REVIEW");
    const calc = await call("fin", "POST", `/feasibility/${fm.data.ROWID}/calculate`, {});
    expect(calc.data.passed).toBe(true);
    const sc = await call("fin", "POST", `/feasibility/${fm.data.ROWID}/scenarios`, {});
    expect(sc.data.map((s: any) => s.name)).toEqual(["Best", "Base", "Worst"]);
    await call("fin", "POST", `/feasibility/${fm.data.ROWID}/scenarios`, {});
    expect(await store.findMany("feasibility_scenarios", { feasibility_id: String(fm.data.ROWID) })).toHaveLength(3);

    // Engine-only transitions are not reachable directly.
    expect((await call("dir", "POST", `/applications/${id}/transition`, { transition: "start_approval" })).error?.code).toBe("INVALID_TRANSITION");

    // Approval chain (D-11): manager → finance → legal → director.
    const started = await call("mgr", "POST", `/applications/${id}/start-approval`);
    expect(started.data.application.status).toBe("APPROVAL_PENDING");
    const approvalId = String(started.data.approval.ROWID);
    expect((await call("mgr", "POST", `/applications/${id}/start-approval`)).status).toBe(409);

    expect((await call("fin", "POST", `/approvals/${approvalId}/approve`, { step: 1 })).error?.code).toBe("APPROVAL_NOT_ALLOWED");
    const inbox = await call("mgr", "GET", "/approvals");
    expect(inbox.data.map((i: any) => String(i.ROWID))).toEqual([approvalId]);
    for (const [user, step] of [["mgr", 1], ["fin", 2], ["legal", 3]] as const) {
      expect((await call(user, "POST", `/approvals/${approvalId}/approve`, { step })).data.outcome).toBe("ADVANCED");
    }
    expect((await call("legal", "POST", `/approvals/${approvalId}/approve`, { step: 3 })).status).toBe(409);
    const done = await call("dir", "POST", `/approvals/${approvalId}/approve`, { step: 4, comments: "Go" });
    expect(done.data.outcome).toBe("APPROVED");
    expect(done.data.entity.status).toBe("APPROVED");
    const detail = await call("dir", "GET", `/approvals/${approvalId}`);
    expect(detail.data.actions).toHaveLength(4);
  });

  it("returns an application to feasibility when an approver sends it back", async () => {
    const { store, a, call } = await setup();
    const fr = await call("mgr", "POST", "/franchisees", { display_name: "Rhodey" });
    const app = await call("mgr", "POST", "/applications", { franchisee_id: String(fr.data.ROWID) });
    const id = String(app.data.ROWID);
    // Fast-forward the record into FEASIBILITY_REVIEW with a passing model.
    const fm = await store.insert("feasibility_models", { tenant_id: a.tenantId, application_id: id, site_id: "1", status: "CALCULATED", passed: true, initial_investment: 100 });
    await store.update("franchise_applications", id, { status: "FEASIBILITY_REVIEW", site_id: "1", feasibility_id: String(fm.ROWID) });
    const started = await call("mgr", "POST", `/applications/${id}/start-approval`);
    const approvalId = String(started.data.approval.ROWID);
    expect((await call("mgr", "POST", `/approvals/${approvalId}/return`, { step: 1 })).error?.code).toBe("VALIDATION_FAILED");
    const back = await call("mgr", "POST", `/approvals/${approvalId}/return`, { step: 1, comments: "Rework the rent" });
    expect(back.data.entity.status).toBe("FEASIBILITY_REVIEW");
  });

  it("blocks approval when feasibility failed", async () => {
    const { store, a, call } = await setup();
    const fr = await call("mgr", "POST", "/franchisees", { display_name: "Vision" });
    const app = await call("mgr", "POST", "/applications", { franchisee_id: String(fr.data.ROWID) });
    const id = String(app.data.ROWID);
    const fm = await store.insert("feasibility_models", { tenant_id: a.tenantId, application_id: id, site_id: "1", status: "CALCULATED", passed: false });
    await store.update("franchise_applications", id, { status: "FEASIBILITY_REVIEW", site_id: "1", feasibility_id: String(fm.ROWID) });
    expect((await call("mgr", "POST", `/applications/${id}/start-approval`)).error?.code).toBe("FEASIBILITY_FAILED");
  });

  it("lets only one of two concurrent reservations win", async () => {
    const { store, call } = await setup();
    const ter = await call("mgr", "POST", "/territories", { name: "Pune East", city: "Pune" });
    const ids: string[] = [];
    for (const name of ["A", "B"]) {
      const fr = await call("mgr", "POST", "/franchisees", { display_name: name });
      const app = await call("mgr", "POST", "/applications", { franchisee_id: String(fr.data.ROWID) });
      await store.update("franchise_applications", String(app.data.ROWID), { status: "QUALIFIED" });
      ids.push(String(app.data.ROWID));
    }
    const results = await Promise.all(ids.map((id) => call("mgr", "POST", `/territories/${ter.data.ROWID}/reserve`, { application_id: id })));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success).map((r) => r.error?.code)).toEqual(["TERRITORY_CONFLICT"]);

    const winner = ids[results.findIndex((r) => r.success)];
    expect((await call("mgr", "POST", `/territories/${ter.data.ROWID}/release`, {})).data.released).toBe(true);
    expect((await call("mgr", "GET", `/applications/${winner}`)).data.territory_id).toBeNull();
    expect((await call("mgr", "POST", "/territories/search", { city: "Pune" })).data).toHaveLength(1);
  });
});

