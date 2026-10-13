import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { newStore } from "./helpers";

const router = buildRouter();

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  await ins("users", { email: "boss@x.test", status: "ACTIVE", role_id: t.roleIds.SUPER_ADMIN, external_user_id: "boss" });
  await ins("users", { email: "dir@x.test", status: "ACTIVE", role_id: t.roleIds.FRANCHISE_DIRECTOR, external_user_id: "dir" });
  await ins("users", { email: "rm@x.test", status: "ACTIVE", role_id: t.roleIds.REGIONAL_MANAGER, external_user_id: "rm", region: "South" });
  const south = await ins("territories", { territory_code: "TER-S", tenant_code_key: `${tid}:TER-S`, name: "Chennai", city: "Chennai", state: "Tamil Nadu", region: "South", status: "ALLOCATED" });
  const west = await ins("territories", { territory_code: "TER-W", tenant_code_key: `${tid}:TER-W`, name: "Pune", city: "Pune", state: "Maharashtra", region: "West", status: "ALLOCATED" });
  await ins("territories", { territory_code: "TER-W2", tenant_code_key: `${tid}:TER-W2`, name: "Nashik", city: "Nashik", state: "Maharashtra", region: "West", status: "AVAILABLE" });
  const mk = async (n: number, ter: { ROWID: unknown }, status: string, appStatus = "ACTIVE") => {
    const fr = await ins("franchisees", { franchise_code: `FR-${n}`, tenant_code_key: `${tid}:FR-${n}`, display_name: `Owner ${n}`, status: "ACTIVE" });
    const app = await ins("franchise_applications", { application_code: `APP-${n}`, tenant_code_key: `${tid}:APP-${n}`, franchisee_id: fr.ROWID, status: appStatus, territory_id: ter.ROWID });
    if (!status) return;
    const site = await ins("sites", { site_code: `SITE-${n}`, tenant_code_key: `${tid}:SITE-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, territory_id: ter.ROWID, status: "READY_FOR_PROJECT" });
    await ins("franchise_projects", { project_code: `PROJ-${n}`, tenant_code_key: `${tid}:PROJ-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: site.ROWID, status, actual_opening_date: status === "OPENED" ? "2026-06-01" : null, readiness_rag: "GREEN" });
  };
  await mk(1, south, "OPENED");
  await mk(2, south, "IN_PROGRESS");
  await mk(3, west, "OPENED");
  await mk(4, west, "", "UNDER_REVIEW");
  const call = async (ext: string, method: string, path: string, query: Record<string, string> = {}, body?: unknown) =>
    (await router.handle({ method, path: `/api/v1${path}`, query, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date("2026-10-11T06:00:00Z") })).body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  return { call, store };
}

describe("regional view", () => {
  it("filters every dashboard to the region asked for", async () => {
    const s = await setup();
    const all = (await s.call("dir", "GET", "/dashboard/network")).data;
    expect(all).toMatchObject({ active_locations: { value: 2 }, openings: { value: 1 } });
    const west = (await s.call("dir", "GET", "/dashboard/network", { region: "West" })).data;
    expect(west).toMatchObject({ active_locations: { value: 1 }, openings: { value: 0 }, applications: { value: 1 } });
    expect((await s.call("dir", "GET", "/dashboard/owner", { region: "West" })).data.stores.map((x: any) => x.project_code)).toEqual(["PROJ-3"]);
    expect((await s.call("dir", "GET", "/dashboard/map", { region: "West" })).data.totals).toEqual({ stores: 1, openings: 0, territories: 1 });
    expect((await s.call("dir", "GET", "/dashboard/territories", { region: "South" })).data.territories).toHaveLength(1);
    const regions = (await s.call("dir", "GET", "/dashboard/regions")).data;
    expect(regions).toEqual({ regions: ["South", "West"], region: null, locked: false });
  });

  it("keeps a regional manager to their own region, whatever they ask for", async () => {
    const s = await setup();
    expect((await s.call("rm", "GET", "/dashboard/regions")).data).toEqual({ regions: ["South"], region: "South", locked: true });
    const net = (await s.call("rm", "GET", "/dashboard/network", { region: "West" })).data;
    expect(net).toMatchObject({ active_locations: { value: 1 }, openings: { value: 1 }, applications: { value: 0 } });
    const owner = (await s.call("rm", "GET", "/dashboard/owner", { region: "West" })).data;
    expect(owner).toMatchObject({ region: "South", region_locked: true, finance: false, receivables: null });
    expect(owner.stores.map((x: any) => x.project_code)).toEqual(["PROJ-1"]);
    expect((await s.call("rm", "GET", "/dashboard/map")).data.totals).toEqual({ stores: 1, openings: 1, territories: 0 });
    expect((await s.call("rm", "GET", "/dashboard/pipeline")).data.funnel[0].count).toBe(2);
    expect((await s.call("rm", "GET", "/analytics", { region: "West" })).data).toMatchObject({ region: "South", regions: ["South"] });
  });

  it("needs a known region for a regional manager, and none for a franchisee", async () => {
    const s = await setup();
    const add = (body: unknown) => s.call("boss", "POST", "/admin/users", {}, body);
    expect((await add({ email: "a@x.test", name: "A", role: "REGIONAL_MANAGER" })).error?.fields).toEqual({ region: "required for this role" });
    expect((await add({ email: "a@x.test", name: "A", role: "REGIONAL_MANAGER", region: "North" })).error?.fields).toEqual({ region: "unknown" });
    const ok = await add({ email: "a@x.test", name: "A", role: "REGIONAL_MANAGER", region: "west" });
    expect(ok.data.user).toMatchObject({ role: "REGIONAL_MANAGER", region: "West" });
    expect((await s.call("boss", "PATCH", `/admin/users/${ok.data.user.id}`, {}, { region: "South" })).data.region).toBe("South");
    expect((await s.call("boss", "GET", "/admin/users")).data.regions).toEqual(["South", "West"]);
  });
});
