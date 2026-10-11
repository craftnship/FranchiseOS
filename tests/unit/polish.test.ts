import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { ApiRequest } from "../../functions/api/router";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { buildLocalProject } from "../../functions/workflows/projectCreation";
import { newStore } from "./helpers";

const router = buildRouter();
type Body = { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };

const ratings = { financial_capacity: 90, business_experience: 80, industry_experience: 70, investment_readiness: 85, time_commitment: 90, profile_quality: 80 };
const siteRatings = { location: 9, footfall: 8, visibility: 8, competition: 7, rent: 8, demographics: 8, parking: 7, accessibility: 8 };
const feasibility = { initial_investment: 4_000_000, monthly_revenue: 1_200_000, gross_margin_pct: 65, monthly_fixed_opex: 400_000, royalty_pct: 6, marketing_fund_pct: 2 };

/** A portal applicant taken to SITE_SUBMITTED, with the brand team's users. */
async function toSite() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const addUser = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: t.tenantId, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  for (const [role, ext] of [["FRANCHISE_MANAGER", "mgr"], ["FRANCHISE_DIRECTOR", "dir"], ["FINANCE_MANAGER", "fin"], ["LEGAL_MANAGER", "legal"]]) await addUser(role, ext);
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const req: ApiRequest = { method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } };
    const res = await router.handle(req, { store, files });
    return { status: res.status, ...(res.body as Body) };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  const fr = await call("mgr", "POST", "/franchisees", { display_name: "Pepper Potts" });
  await addUser("FRANCHISEE", "pepper", String(fr.data.ROWID));
  const app = await call("pepper", "POST", "/applications", { application_type: "UNIT", preferred_city: "Chennai", investment_capacity: 5_000_000 });
  const id = String(app.data.ROWID);
  for (const d of ["ID_PROOF", "ADDRESS_PROOF", "BANK_STATEMENT"]) await call("pepper", "POST", `/applications/${id}/documents`, { document_type: d, file_ref: `https://workdrive.zoho.in/${d}` });
  await call("pepper", "POST", `/applications/${id}/submit`);
  const ter = await call("mgr", "POST", "/territories", { name: "Chennai Central", city: "Chennai", franchise_type: "QSR", population_index: 80, market_index: 70, income_index: 60, competition_index: 40 });
  await call("mgr", "POST", `/applications/${id}/transition`, { transition: "start_review" });
  await call("mgr", "POST", `/applications/${id}/score`, { ratings });
  await call("mgr", "POST", `/applications/${id}/transition`, { transition: "qualify" });
  await call("mgr", "POST", `/territories/${ter.data.ROWID}/reserve`, { application_id: id });
  await call("mgr", "POST", `/applications/${id}/transition`, { transition: "require_site" });
  const site = await call("pepper", "POST", "/sites", { application_id: id, city: "Chennai", address_line_1: "1 Anna Salai", rent: 150000 });
  return { store, t, call, inbox, id, siteId: String(site.data.ROWID), code: String(app.data.application_code) };
}

async function approveSite(call: Awaited<ReturnType<typeof toSite>>["call"], siteId: string) {
  for (const tr of ["screen", "schedule_visit", "start_evaluation"]) await call("mgr", "POST", `/sites/${siteId}/transition`, { transition: tr });
  await call("mgr", "POST", `/sites/${siteId}/evaluate`, { ratings: siteRatings });
  await call("mgr", "POST", `/sites/${siteId}/transition`, { transition: "request_signoff" });
  await call("dir", "POST", `/sites/${siteId}/approve`);
}

describe("polish pass", () => {
  it("tells the franchise manager when a franchisee submits or proposes a site from the portal", async () => {
    const s = await toSite();
    expect(await s.inbox("mgr")).toEqual(expect.arrayContaining([`${s.code} submitted by Pepper Potts`, `Pepper Potts proposed a site for ${s.code}`]));
  });

  it("accepts only web links as linked documents", async () => {
    const s = await toSite();
    const bad = await s.call("pepper", "POST", `/applications/${s.id}/documents`, { document_type: "OTHER", file_ref: "stratus:tenants/999/applications/1/x/secret.pdf" });
    expect(bad.error?.fields).toEqual({ file_ref: "not a web link" });
  });

  it("swaps in a replacement for a rejected site and won't approve on the old one", async () => {
    const s = await toSite();
    await s.call("mgr", "POST", `/sites/${s.siteId}/transition`, { transition: "screen" });
    await s.call("dir", "POST", `/sites/${s.siteId}/transition`, { transition: "reject" });
    const next = await s.call("pepper", "POST", "/sites", { application_id: s.id, city: "Chennai", address_line_1: "9 Mount Road", rent: 140000 });
    expect((await s.call("mgr", "GET", `/applications/${s.id}`)).data.site_id).toBe(String(next.data.ROWID));
    const wrong = await s.call("fin", "POST", "/feasibility", { application_id: s.id, site_id: s.siteId, ...feasibility });
    expect(wrong.error?.fields).toEqual({ site_id: "rejected" });
  });

  it("pauses decisions on a held application and closes its approval when it is withdrawn", async () => {
    const s = await toSite();
    await approveSite(s.call, s.siteId);
    const fm = await s.call("fin", "POST", "/feasibility", { application_id: s.id, ...feasibility });
    await s.call("fin", "POST", `/feasibility/${fm.data.ROWID}/calculate`, {});
    const approvalId = String((await s.call("mgr", "POST", `/applications/${s.id}/start-approval`)).data.approval.ROWID);
    await s.call("mgr", "POST", `/applications/${s.id}/transition`, { transition: "hold" });
    expect((await s.call("mgr", "POST", `/approvals/${approvalId}/approve`, { step: 1 })).error?.code).toBe("INVALID_TRANSITION");
    await s.call("mgr", "POST", `/applications/${s.id}/transition`, { transition: "resume" });
    expect((await s.call("mgr", "POST", `/approvals/${approvalId}/approve`, { step: 1 })).data.outcome).toBe("ADVANCED");
    await s.call("mgr", "POST", `/applications/${s.id}/transition`, { transition: "withdraw" });
    expect((await s.call("fin", "GET", "/approvals")).data).toEqual([]);
    expect((await s.store.findOne("approval_instances", { ROWID: approvalId }))?.status).toBe("CANCELLED");
  });

  it("can reject an application at any open stage", async () => {
    const s = await toSite();
    expect((await s.call("mgr", "POST", `/applications/${s.id}/transition`, { transition: "reject" })).data.status).toBe("REJECTED");
  });

  it("plans a project with a local checklist when Zoho Projects isn't connected", async () => {
    const store = newStore();
    const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    const p = await store.insert("franchise_projects", { tenant_id: t.tenantId, project_code: "PROJ-000001", tenant_code_key: `${t.tenantId}:PROJ-000001`, status: "NOT_STARTED" });
    const ctx = { tenantId: t.tenantId, userId: null, roles: ["SUPER_ADMIN"], requestId: "T" } as any;
    const template = [{ code: "LEASE", name: "Sign lease", category: "Construction", mandatory: true, offset_days: 10 }, { code: "FITOUT", name: "Fit-out", category: "Construction", mandatory: true, offset_days: 40, depends_on: ["LEASE"] }];
    expect((await buildLocalProject(store, ctx, { projectRowId: String(p.ROWID), template, startDate: "2026-10-01" })).tasksCreated).toBe(2);
    expect((await buildLocalProject(store, ctx, { projectRowId: String(p.ROWID), template, startDate: "2026-10-01" })).tasksCreated).toBe(0);
    expect((await store.findOne("franchise_projects", { ROWID: p.ROWID }))?.status).toBe("PLANNING");
    expect((await store.findMany("opening_checklists", { project_id: String(p.ROWID) })).map((r) => [r.task_code, r.due_date, r.duration_days])).toEqual([["LEASE", "2026-10-11", 10], ["FITOUT", "2026-11-10", 30]]);
  });
});
