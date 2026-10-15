import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { maskContacts, readOnlyStore } from "../../functions/common/demo";
import { newStore } from "./helpers";

// A read-only demo link (docs/deploy-pilot.md, "Demo link"): created from Settings, it opens the
// staff screens with no sign-in, changes nothing, and masks contact details.

const router = buildRouter();
const NOW = "2026-10-15T06:00:00Z";

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  const user = (role: string, ext: string, extra: Record<string, unknown> = {}) => ins("users", { email: `${ext}@x.test`, name: ext, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, ...extra });
  await user("SUPER_ADMIN", "tony");
  await user("FRANCHISE_MANAGER", "fm");
  const fr = await ins("franchisees", { franchise_code: "FR-1", tenant_code_key: `${tid}:FR-1`, display_name: "Pepper Potts", email: "pepper.potts@x.test", phone: "9090390903", status: "ACTIVE" });
  const app = await ins("franchise_applications", { application_code: "APP-1", tenant_code_key: `${tid}:APP-1`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  const agreement = await ins("agreements", { agreement_code: "AGR-1", tenant_code_key: `${tid}:AGR-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", signed_at: "2026-06-01T10:00:00Z", fee_status: "PAID", fee_total: 500_000, fee_balance: 0 });
  const project = await ins("franchise_projects", { project_code: "PROJ-1", tenant_code_key: `${tid}:PROJ-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "OPENED", actual_opening_date: "2026-09-01" });
  // A fit-out instalment that is already late, so GET /collections has something to sync.
  await ins("fee_instalments", { project_id: project.ROWID, agreement_id: agreement.ROWID, franchisee_id: fr.ROWID, seq: 2, instalment_key: `${tid}:${agreement.ROWID}:2`, kind: "FEE", label: "At fit-out", amount: 200_000, raise_on: "TASK", status: "INVOICED", zoho_books_invoice_id: "INV-2", invoice_number: "INV/2", invoice_total: 200_000, invoice_balance: 200_000, invoice_due_date: "2026-09-20", invoiced_on: "2026-09-05" });
  const asUser = async (ext: string, method: string, path: string, body?: unknown, now = NOW) =>
    (await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now) })).body as any;
  const asDemo = async (token: string | undefined, method: string, path: string, body?: unknown, now = NOW) =>
    (await router.handle({ method, path: `/api/v1${path}`, body, identity: null, demoToken: token }, { store, now: () => new Date(now), zoho: async () => { throw new Error("Zoho must not be called in a demo"); } })).body as any;
  return { store, tid, fr, asUser, asDemo };
}

describe("demo link", () => {
  it("is created and turned off from Settings by a super admin only", async () => {
    const s = await setup();
    expect((await s.asUser("fm", "GET", "/settings/demo-link")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.asUser("tony", "GET", "/settings/demo-link")).data).toEqual({ active: false, token: null, expires_on: null, created_at: null });
    const made = (await s.asUser("tony", "POST", "/settings/demo-link", {})).data;
    expect(made).toMatchObject({ active: true, expires_on: "2026-11-14", created_at: NOW.replace("Z", ".000Z") });
    expect(made.token).toMatch(/^STARK\.[A-Za-z0-9_-]{32}$/);
    expect((await s.asUser("tony", "GET", "/settings/demo-link")).data.token).toBe(made.token);
    expect((await s.asUser("tony", "POST", "/settings/demo-link", { days: 365 })).error?.fields).toHaveProperty("days");
    // The link shows up in the activity log, and turning it off does too.
    expect((await s.asUser("tony", "DELETE", "/settings/demo-link")).data).toMatchObject({ active: false, token: null });
    const log = (await s.asUser("tony", "GET", "/audit")).data;
    const actions = (Array.isArray(log) ? log : log.items).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["settings:demo_link_create", "settings:demo_link_revoke"]));
  });

  it("opens the staff screens read-only, with contact details masked and nothing written", async () => {
    const s = await setup();
    const { token } = (await s.asUser("tony", "POST", "/settings/demo-link", { days: 7 })).data;
    const me = (await s.asDemo(token, "GET", "/me")).data;
    expect(me).toMatchObject({ user_id: "DEMO", tenant_id: s.tid, roles: ["DEMO_VIEWER"], name: "Demo viewer", email: null, demo: true, zoho_web: null });
    expect(me.permissions).toEqual(["audit.view", "dashboard.view", "finance.view"]);
    // Screens the demo may read, with the franchisee's email and phone hidden.
    expect((await s.asDemo(token, "GET", "/dashboard/network")).success).toBe(true);
    const list = (await s.asDemo(token, "GET", "/franchisees")).data;
    const pepper = (Array.isArray(list) ? list : list.items).find((f: any) => f.franchise_code === "FR-1");
    expect(pepper).toMatchObject({ display_name: "Pepper Potts", email: "p•••@x.test", phone: "90•••••903" });
    expect((await s.asDemo(token, "GET", `/franchisees/${s.fr.ROWID}`)).data.email).toBe("p•••@x.test");
    // Admin stays out of reach, and nothing may change.
    expect((await s.asDemo(token, "GET", "/admin/users")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.asDemo(token, "GET", "/settings/demo-link")).error?.code).toBe("ACCESS_DENIED");
    const post = await s.asDemo(token, "POST", "/franchisees", { display_name: "New" });
    expect(post.error).toMatchObject({ code: "ACCESS_DENIED", message: "This is a read-only demo, so changes are disabled." });
    // Collections tidies itself up on read for staff; for the demo the list still answers but nothing is stored.
    const stored = async () => (await s.store.findMany("collections", { tenant_id: s.tid })).length;
    expect((await s.asDemo(token, "GET", "/collections")).data.items.length).toBe(0);
    expect(await stored()).toBe(0);
    expect((await s.asUser("tony", "GET", "/collections")).data.items.length).toBe(1);
    expect(await stored()).toBe(1);
    expect((await s.asDemo(token, "GET", "/collections")).data.items[0]).toMatchObject({ status: "OPEN", franchisee: "Pepper Potts" });
    expect(await stored()).toBe(1);
    expect((await s.store.findMany("activity_logs", { tenant_id: s.tid })).some((e) => e.actor_user_id === "DEMO")).toBe(false);
  });

  it("refuses a forged, replaced, turned-off or lapsed link, and a signed-in user keeps their own access", async () => {
    const s = await setup();
    expect((await s.asDemo(undefined, "GET", "/me")).error?.code).toBe("AUTH_REQUIRED");
    expect((await s.asDemo("STARK.nope", "GET", "/me")).error?.code).toBe("DEMO_LINK_INVALID");
    expect((await s.asDemo("OTHER.nope", "GET", "/me")).error?.code).toBe("DEMO_LINK_INVALID");
    const first = (await s.asUser("tony", "POST", "/settings/demo-link", { days: 2 })).data.token;
    expect((await s.asDemo(first, "GET", "/me")).data.demo).toBe(true);
    expect((await s.asDemo(first.slice(0, -1) + (first.endsWith("a") ? "b" : "a"), "GET", "/me")).error?.code).toBe("DEMO_LINK_INVALID");
    // Lapsed the day after it expires; a new link replaces the old one; off is off.
    expect((await s.asDemo(first, "GET", "/me", undefined, "2026-10-17T23:00:00Z")).data.demo).toBe(true);
    expect((await s.asDemo(first, "GET", "/me", undefined, "2026-10-18T00:30:00Z")).error?.code).toBe("DEMO_LINK_INVALID");
    const second = (await s.asUser("tony", "POST", "/settings/demo-link", {})).data.token;
    expect((await s.asDemo(first, "GET", "/me")).error?.code).toBe("DEMO_LINK_INVALID");
    expect((await s.asDemo(second, "GET", "/me")).data.demo).toBe(true);
    await s.asUser("tony", "DELETE", "/settings/demo-link");
    expect((await s.asDemo(second, "GET", "/me")).error?.code).toBe("DEMO_LINK_INVALID");
    // The header is ignored once someone is signed in.
    const signed = (await router.handle({ method: "GET", path: "/api/v1/me", identity: { externalUserId: "tony", email: "tony@x.test" }, demoToken: "STARK.nope" }, { store: s.store, now: () => new Date(NOW) })).body as any;
    expect(signed.data).toMatchObject({ roles: ["SUPER_ADMIN"], name: "tony" });
    expect(signed.data.demo).toBeUndefined();
  });

  it("masks contact keys deeply and keeps everything else", async () => {
    const masked = maskContacts({ email: "santhosh@zoho.com", owner: { phone: "+91 90903 90903", mobile: "12345", emailed_to: "a@b.c", name: "A B", notes: "call 9090390903" }, items: [{ contact_number: "044-2345678", amount: 100 }] });
    expect(masked).toEqual({ email: "s•••@zoho.com", owner: { phone: "91•••••••903", mobile: "•••••", emailed_to: "a•••@b.c", name: "A B", notes: "call 9090390903" }, items: [{ contact_number: "04•••••678", amount: 100 }] });
    const store = newStore();
    const row = await store.insert("tenants", { tenant_code: "X", name: "X", status: "ACTIVE", zoho_dc: "IN" });
    const ro = readOnlyStore(store);
    expect((await ro.insert("tenants", { tenant_code: "Y", name: "Y" })).ROWID).toBe("0");
    expect((await ro.update("tenants", String(row.ROWID), { name: "Changed" })).name).toBe("Changed");
    expect((await store.findMany("tenants", {})).map((t) => t.name)).toEqual(["X"]);
  });
});
