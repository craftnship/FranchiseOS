import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { newStore } from "./helpers";

// Who may read what inside one tenant: money and people are not for every signed-in staff member,
// a vendor is not a franchisee, and a user with no role is nobody.

const router = buildRouter();

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  const user = (role: string, ext: string, extra: Record<string, unknown> = {}) => ins("users", { email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, ...extra });
  await user("SUPER_ADMIN", "boss");
  await user("FINANCE_MANAGER", "fin");
  await user("PROJECT_MANAGER", "pm");
  await user("TRAINING_MANAGER", "trainer");
  await user("OPERATIONS_MANAGER", "ops");
  await user("LEGAL_MANAGER", "legal");
  const fr = await ins("franchisees", { franchise_code: "FR-1", tenant_code_key: `${tid}:FR-1`, display_name: "Owner 1", status: "ACTIVE" });
  await user("FRANCHISEE", "owner", { franchisee_id: fr.ROWID });
  // A vendor row that was given a franchisee by hand must still not act as that franchisee.
  await user("VENDOR", "vendor", { franchisee_id: fr.ROWID });
  await ins("users", { email: "ghost@x.test", status: "ACTIVE", role_id: null, external_user_id: "ghost" });
  const app = await ins("franchise_applications", { application_code: "APP-1", tenant_code_key: `${tid}:APP-1`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  const site = await ins("sites", { site_code: "SITE-1", tenant_code_key: `${tid}:SITE-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "READY_FOR_PROJECT" });
  await ins("agreements", { agreement_code: "AGR-1", tenant_code_key: `${tid}:AGR-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", fee_status: "OVERDUE", fee_total: 500_000, fee_balance: 500_000, fee_due_date: "2026-08-01" });
  const project = await ins("franchise_projects", { project_code: "PROJ-1", tenant_code_key: `${tid}:PROJ-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: site.ROWID, status: "IN_PROGRESS" });
  const call = async (ext: string, method: string, path: string, body?: unknown) =>
    (await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date("2026-10-11T06:00:00Z") })).body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  return { call, store, tid, project, fr, base: `/projects/${project.ROWID}` };
}

describe("access inside a tenant", () => {
  it("keeps loans, capex and staff records to the people who manage them, and the franchisee", async () => {
    const s = await setup();
    for (const path of ["/funding", "/capex"]) {
      expect((await s.call("legal", "GET", `${s.base}${path}`)).error?.code).toBe("ACCESS_DENIED");
      expect((await s.call("ops", "GET", `${s.base}${path}`)).error?.code).toBe("ACCESS_DENIED");
      expect((await s.call("pm", "GET", `${s.base}${path}`)).success).toBe(true);
      expect((await s.call("fin", "GET", `${s.base}${path}`)).success).toBe(true);
      expect((await s.call("owner", "GET", `${s.base}${path}`)).success).toBe(true);
    }
    // Staff records: project roles and those who watch the network, not legal.
    expect((await s.call("legal", "GET", `${s.base}/staffing`)).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("trainer", "GET", `${s.base}/staffing`)).success).toBe(true);
    expect((await s.call("ops", "GET", `${s.base}/staffing`)).success).toBe(true);
  });

  it("shows fee amounts only to finance and the franchisee", async () => {
    const s = await setup();
    const ops = (await s.call("ops", "GET", "/agreements")).data[0];
    expect(ops).toMatchObject({ agreement_code: "AGR-1", fee_status: "OVERDUE", fee_total: null, fee_balance: null, fee_due_date: null });
    expect((await s.call("ops", "GET", `/agreements/${ops.ROWID}`)).data.fee_total).toBeNull();
    expect((await s.call("fin", "GET", "/agreements")).data[0].fee_total).toBe(500_000);
    expect((await s.call("owner", "GET", "/agreements")).data[0].fee_balance).toBe(500_000);
  });

  it("never lets a vendor act as a franchisee, and refuses to link one", async () => {
    const s = await setup();
    expect((await s.call("vendor", "GET", s.base)).error?.code).toBe("NOT_FOUND");
    expect((await s.call("vendor", "GET", "/agreements")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("boss", "POST", "/admin/users", { email: "v@x.test", name: "V", role: "VENDOR", franchisee_id: String(s.fr.ROWID) })).error?.fields).toEqual({ franchisee_id: "only for franchisee roles" });
  });

  it("turns away a user with no role, and lets only a super admin make one", async () => {
    const s = await setup();
    expect((await s.call("ghost", "GET", "/projects")).error?.code).toBe("ACCESS_DENIED");
    const u = (await s.call("boss", "POST", "/admin/users", { email: "n@x.test", name: "N", role: "OPERATIONS_MANAGER" })).data.user;
    // Give the operations manager user.admin, then watch it stop short of super admin.
    await s.store.insert("role_permissions", { tenant_id: s.tid, role_id: (await s.store.findOne("roles", { tenant_id: s.tid, code: "OPERATIONS_MANAGER" }))!.ROWID, permission_code: "user.admin", perm_key: `${s.tid}:OPERATIONS_MANAGER:user.admin` });
    expect((await s.call("ops", "PATCH", `/admin/users/${u.id}`, { role: "PROJECT_MANAGER" })).success).toBe(true);
    expect((await s.call("ops", "PATCH", `/admin/users/${u.id}`, { role: "SUPER_ADMIN" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("ops", "POST", "/admin/users", { email: "a@x.test", name: "A", role: "SUPER_ADMIN" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("boss", "PATCH", `/admin/users/${u.id}`, { role: "SUPER_ADMIN" })).data.role).toBe("SUPER_ADMIN");
  });
});
