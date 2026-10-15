import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { AuthAdmin } from "../../functions/common/authAdmin";
import { newStore } from "./helpers";

const router = buildRouter();

async function setup(auth?: AuthAdmin) {
  const store = newStore();
  const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = a.tenantId;
  const admin = await store.insert("users", { tenant_id: tid, email: "tony@x.test", name: "Tony", status: "ACTIVE", role_id: a.roleIds.SUPER_ADMIN, external_user_id: "tony" });
  await store.insert("users", { tenant_id: tid, email: "pm@x.test", name: "Pat", status: "ACTIVE", role_id: a.roleIds.PROJECT_MANAGER, external_user_id: "pm" });
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper", status: "ACTIVE" });
  const call = async (ext: string, method: string, path: string, body?: unknown, email = `${ext}@x.test`) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email } }, { store, auth });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  return { store, call, admin, fr, roleIds: a.roleIds };
}

describe("user admin", () => {
  it("lists people and roles with their permissions", async () => {
    const s = await setup();
    const r = await s.call("tony", "GET", "/admin/users");
    expect(r.data.users.map((u: any) => [u.name, u.role, u.signed_in])).toEqual([["Pat", "PROJECT_MANAGER", true], ["Tony", "SUPER_ADMIN", true]]);
    expect(r.data.roles.find((x: any) => x.code === "PROJECT_MANAGER")).toMatchObject({ permissions: ["dashboard.view", "project.open", "project.write"], active_users: 1 });
    expect(r.data.invites_by_email).toBe(false);
    expect((await s.call("pm", "GET", "/admin/users")).error?.code).toBe("ACCESS_DENIED");
  });

  it("adds a person who is linked by their verified email on first sign-in", async () => {
    const s = await setup();
    expect((await s.call("tony", "POST", "/admin/users", { email: "pepper@x.test", name: "Pepper Potts", role: "FRANCHISEE" })).error?.fields).toEqual({ franchisee_id: "required for this role" });
    expect((await s.call("tony", "POST", "/admin/users", { email: "PM@x.test", name: "Again", role: "FINANCE_MANAGER" })).error?.fields).toEqual({ email: "already added" });
    const add = await s.call("tony", "POST", "/admin/users", { email: "Pepper@X.test", name: "Pepper Potts", role: "FRANCHISEE", franchisee_id: String(s.fr.ROWID) });
    expect(add.data).toMatchObject({ user: { email: "pepper@x.test", status: "INVITED", role: "FRANCHISEE", franchisee: { name: "Pepper" }, signed_in: false }, email_sent: false });
    // Someone else's sign-in doesn't match; hers does, once.
    expect((await s.call("cat-9", "GET", "/me", undefined, "other@x.test")).error?.code).toBe("ACCESS_DENIED");
    const me = await s.call("cat-7", "GET", "/me", undefined, "pepper@x.test");
    expect(me.data).toMatchObject({ roles: ["FRANCHISEE"], franchisee_id: String(s.fr.ROWID) });
    expect(await s.store.findOne("users", { ROWID: add.data.user.id })).toMatchObject({ status: "ACTIVE", external_user_id: "cat-7" });
    const log = await s.call("tony", "GET", "/audit", undefined);
    expect(log.data.items.map((i: any) => i.action).slice(0, 2)).toEqual(["user:linked", "user:invited"]);
  });

  it("sends a Catalyst invitation when invites are on", async () => {
    const sent: string[] = [];
    const s = await setup({ invite: async (u) => { sent.push(`${u.firstName}|${u.lastName}|${u.email}`); return { externalUserId: "cat-55" }; } });
    const add = await s.call("tony", "POST", "/admin/users", { email: "happy@x.test", name: "Happy Hogan", role: "PROJECT_MANAGER" });
    expect(add.data.email_sent).toBe(true);
    expect(sent).toEqual(["Happy|Hogan|happy@x.test"]);
    expect((await s.call("cat-55", "GET", "/me", undefined, "different@x.test")).data.roles).toEqual(["PROJECT_MANAGER"]);
  });

  it("changes role and status, but never locks the tenant out", async () => {
    const s = await setup();
    const users = (await s.call("tony", "GET", "/admin/users")).data.users;
    const pat = users.find((u: any) => u.name === "Pat").id;
    expect((await s.call("tony", "PATCH", `/admin/users/${s.admin.ROWID}`, { status: "INACTIVE" })).error?.fields).toEqual({ status: "not on your own account" });
    expect((await s.call("tony", "PATCH", `/admin/users/${pat}`, { franchisee_id: String(s.fr.ROWID) })).error?.fields).toEqual({ franchisee_id: "only for franchisee roles" });
    expect((await s.call("tony", "PATCH", `/admin/users/${pat}`, { role: "FINANCE_MANAGER" })).data).toMatchObject({ role: "FINANCE_MANAGER" });
    expect((await s.call("tony", "PATCH", `/admin/users/${pat}`, { status: "INACTIVE" })).data).toMatchObject({ status: "INACTIVE" });
    expect((await s.call("pm", "GET", "/me")).error?.code).toBe("ACCESS_DENIED");
    // Pat as a second super admin can't remove Tony if Tony would be the last one.
    await s.call("tony", "PATCH", `/admin/users/${pat}`, { status: "ACTIVE", role: "SUPER_ADMIN" });
    expect((await s.call("pm", "PATCH", `/admin/users/${s.admin.ROWID}`, { role: "FINANCE_MANAGER" })).data.role).toBe("FINANCE_MANAGER");
    expect((await s.call("tony", "PATCH", `/admin/users/${pat}`, { status: "INACTIVE" })).error?.code).toBe("ACCESS_DENIED");
    const actions = (await s.call("pm", "GET", "/audit")).data.items.map((i: any) => i.action);
    expect(actions.slice(0, 4)).toEqual(["user:updated", "user:reactivated", "user:deactivated", "user:updated"]);
  });
});
