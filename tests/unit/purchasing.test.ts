import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { runReminderJob } from "../../functions/workflows/notifications";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");
const pdf = { file_name: "dn.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 dn").toString("base64") };

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("SUPER_ADMIN", "admin");
  await user("PROJECT_MANAGER", "pm");
  await user("FRANCHISE_MANAGER", "mgr");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: "1", franchisee_id: fr.ROWID, site_id: "1", status: "IN_PROGRESS", target_opening_date: "2026-11-30" });
  const task = (code: string, due: string) => store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: code, item: code, category: "EQUIPMENT", weight: 1, mandatory: true, status: "OPEN", due_date: due });
  const tasks = { order: await task("EQUIP_ORDER", "2026-10-20"), install: await task("EQUIP_INSTALL", "2026-11-05"), stock: await task("OPENING_STOCK", "2026-11-20") };
  const call = async (ext: string, method: string, path: string, body?: unknown, query?: Record<string, string>, now = NOW) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => now });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}`;
  const status = async (id: unknown) => (await store.findOne("opening_checklists", { ROWID: String(id) }))?.status;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, call, base, tasks, status, inbox };
}

async function catalogue(s: Awaited<ReturnType<typeof setup>>) {
  const kitchenCo = (await s.call("admin", "POST", "/vendors", { name: "Chennai Kitchen Co", category: "KITCHEN", email: "sales@ckc.test", gstin: "33ABCDE1234F1Z5" })).data;
  const foods = (await s.call("admin", "POST", "/vendors", { name: "Fresh Foods", category: "STOCK" })).data;
  const item = async (vendor: any, name: string, category: string, unit_price: number, standard_qty?: number) =>
    (await s.call("admin", "POST", "/vendor-items", { vendor_id: vendor.ROWID, name, category, unit_price, unit: "each", ...(standard_qty ? { standard: true, standard_qty } : {}) })).data;
  return {
    kitchenCo, foods,
    fryer: await item(kitchenCo, "Twin fryer", "KITCHEN", 85000, 2),
    oven: await item(kitchenCo, "Combi oven", "KITCHEN", 240000, 1),
    tongs: await item(kitchenCo, "Tongs", "KITCHEN", 300),
    stock: await item(foods, "Opening stock kit", "STOCK", 60000, 1),
  };
}

describe("vendor catalogue", () => {
  it("only vendor.manage keeps it; everyone sees approved vendors and active items", async () => {
    const s = await setup();
    expect((await s.call("mgr", "POST", "/vendors", { name: "Somebody", category: "KITCHEN" })).error?.code).toBe("ACCESS_DENIED");
    const c = await catalogue(s);
    expect((await s.call("admin", "POST", "/vendors", { name: "chennai kitchen co", category: "KITCHEN" })).error?.fields).toEqual({ name: "already in the catalogue" });
    expect((await s.call("admin", "POST", "/vendor-items", { vendor_id: c.kitchenCo.ROWID, name: "Grill", category: "KITCHEN", unit_price: 1, standard: true })).error?.fields).toEqual({ standard_qty: "required for the standard package" });
    await s.call("admin", "PATCH", `/vendor-items/${c.tongs.ROWID}`, { active: false });
    await s.call("admin", "PATCH", `/vendors/${c.foods.ROWID}`, { approved: false, reason: "Failed hygiene audit" });
    const seen = (await s.call("pepper", "GET", "/vendors")).data.vendors;
    expect(seen.map((v: any) => v.name)).toEqual(["Chennai Kitchen Co"]);
    expect(seen[0].items.map((i: any) => i.name)).toEqual(["Combi oven", "Twin fryer"]);
    expect((await s.call("pepper", "GET", "/vendors", undefined, { all: "true" })).error?.code).toBe("ACCESS_DENIED");
    const all = (await s.call("admin", "GET", "/vendors", undefined, { all: "true" })).data.vendors;
    expect(all.map((v: any) => [v.name, v.status, v.items.length])).toEqual([["Chennai Kitchen Co", "APPROVED", 3], ["Fresh Foods", "SUSPENDED", 1]]);
    // Nobody orders from a suspended vendor.
    expect((await s.call("pepper", "POST", `${s.base}/purchase-orders`, { vendor_id: c.foods.ROWID, lines: [{ item_id: c.stock.ROWID, qty: 1 }] })).error?.fields).toEqual({ vendor_id: "not approved" });
  });
});

describe("purchase orders", () => {
  it("the store orders the package, staff confirm dates, deliveries count as capex and complete the tasks", async () => {
    const s = await setup();
    const c = await catalogue(s);
    const order = (ext: string, vendor: any, lines: object[], extra: object = {}) => s.call(ext, "POST", `${s.base}/purchase-orders`, { vendor_id: vendor.ROWID, lines, ...extra });
    // Items must belong to the vendor; ordering can't be ticked off by hand before the package is ordered.
    expect((await order("pepper", c.kitchenCo, [{ item_id: c.stock.ROWID, qty: 1 }])).error?.fields).toEqual({ lines: "item not in the catalogue" });
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.tasks.order.ROWID}`, { done: true })).error?.fields).toEqual({ package: "2 items not ordered" });
    const po1 = (await order("pepper", c.kitchenCo, [{ item_id: c.fryer.ROWID, qty: 2 }, { item_id: c.tongs.ROWID, qty: 10 }])).data;
    expect(po1).toMatchObject({ po_number: "PO-PROJ-000001-01", status: "PLACED", total: 173000, source: "PORTAL", needed_by: "2026-11-05", tasks_completed: [] });
    expect(await s.inbox("pm")).toContain("PROJ-000001 placed PO-PROJ-000001-01 with Chennai Kitchen Co for ₹1,73,000");
    const po2 = (await order("pm", c.kitchenCo, [{ item_id: c.oven.ROWID, qty: 1 }])).data;
    expect(po2.tasks_completed).toEqual(["EQUIP_ORDER"]);
    expect(await s.status(s.tasks.order.ROWID)).toBe("COMPLETED");
    // Only staff confirm, with the vendor's date; a date after the install is due shows as late.
    expect((await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${po1.ROWID}`, { action: "confirm", expected_delivery: "2026-10-25" })).error?.code).toBe("ACCESS_DENIED");
    await s.call("pm", "PATCH", `${s.base}/purchase-orders/${po1.ROWID}`, { action: "confirm", expected_delivery: "2026-10-25", vendor_ref: "SO-881" });
    await s.call("pm", "PATCH", `${s.base}/purchase-orders/${po2.ROWID}`, { action: "confirm", expected_delivery: "2026-11-12" });
    expect(await s.inbox("pepper")).toContain("PO-PROJ-000001-01 is confirmed: Chennai Kitchen Co delivers 25 Oct 2026");
    let p = (await s.call("pepper", "GET", `${s.base}/purchasing`)).data;
    expect(p.orders.map((o: any) => [o.po_number, o.status, o.late])).toEqual([["PO-PROJ-000001-02", "CONFIRMED", true], ["PO-PROJ-000001-01", "CONFIRMED", false]]);
    expect(p.package.map((x: any) => [x.name, x.needed, x.ordered, x.delivered])).toEqual([["Combi oven", 1, 1, 0], ["Twin fryer", 2, 2, 0], ["Opening stock kit", 1, 0, 0]]);
    expect(p.met).toEqual({ ordered: true, installed_ready: false, stock: false });
    expect(p.open_value).toBe(413000);
    // Installation waits for the equipment to arrive.
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.tasks.install.ROWID}`, { done: true })).error?.fields).toEqual({ package: "2 items not delivered" });
    // The franchisee records deliveries with the delivery note; the spend lands in capex once.
    expect((await s.call("happy", "PATCH", `${s.base}/purchase-orders/${po1.ROWID}`, { action: "deliver", delivered_on: "2026-10-08" })).error?.code).toBe("NOT_FOUND");
    const d1 = await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${po1.ROWID}`, { action: "deliver", delivered_on: "2026-10-08", note: "All in good condition", delivery_note: pdf });
    expect(d1.data).toMatchObject({ status: "DELIVERED", delivered_on: "2026-10-08" });
    expect((await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${po1.ROWID}`, { action: "deliver", delivered_on: "2026-10-08" })).error?.code).toBe("INVALID_TRANSITION");
    await s.call("pm", "PATCH", `${s.base}/purchase-orders/${po2.ROWID}`, { action: "deliver", delivered_on: "2026-10-09" });
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.tasks.install.ROWID}`, { done: true })).success).toBe(true);
    const capex = (await s.call("pm", "GET", `${s.base}/capex`)).data;
    const po = capex.spend.filter((x: any) => x.source === "PO");
    expect(po.map((x: any) => [x.reference, x.category, x.amount])).toEqual(expect.arrayContaining([["PO-PROJ-000001-01", "KITCHEN", 173000], ["PO-PROJ-000001-02", "KITCHEN", 240000]]));
    expect(po).toHaveLength(2);
    expect((await s.call("pepper", "GET", `${s.base}/purchase-orders/${po1.ROWID}/delivery-note`)).data.url).toBeTruthy();
    // Stock arrives and completes its task; the franchisee can cancel only while an order is placed.
    const po3 = (await order("pepper", c.foods, [{ item_id: c.stock.ROWID, qty: 1 }])).data;
    const extra = (await order("pepper", c.foods, [{ item_id: c.stock.ROWID, qty: 1 }])).data;
    expect((await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${extra.ROWID}`, { action: "cancel", reason: "Ordered twice" })).data.status).toBe("CANCELLED");
    await s.call("pm", "PATCH", `${s.base}/purchase-orders/${po3.ROWID}`, { action: "confirm", expected_delivery: "2026-10-10" });
    expect((await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${po3.ROWID}`, { action: "cancel", reason: "Changed mind" })).error?.code).toBe("ACCESS_DENIED");
    // A day past the date, both sides hear it's late.
    await runReminderJob(s.store, { now: new Date("2026-10-12T03:00:00Z"), requestId: "R1" });
    expect(await s.inbox("pm")).toContain("PO-PROJ-000001-03 from Fresh Foods is late");
    expect(await s.inbox("pepper")).toContain("PO-PROJ-000001-03 from Fresh Foods is late");
    const d3 = await s.call("pepper", "PATCH", `${s.base}/purchase-orders/${po3.ROWID}`, { action: "deliver", delivered_on: "2026-10-09" });
    expect(d3.data.tasks_completed).toEqual(["OPENING_STOCK"]);
    p = (await s.call("pm", "GET", `${s.base}/purchasing`)).data;
    expect(p.met).toEqual({ ordered: true, installed_ready: true, stock: true });
    expect(p.delivered_value).toBe(473000);
  });
});
