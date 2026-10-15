import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { BooksBill } from "../../functions/integrations/clients";
import { categoryFromReference } from "../../functions/workflows/capex";
import { runTwoWaySyncJob } from "../../functions/workflows/twoWaySync";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("PROJECT_MANAGER", "pm");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "ONBOARDING" });
  const fm = await store.insert("feasibility_models", { tenant_id: tid, application_id: app.ROWID, site_id: "1", status: "CALCULATED", passed: true, initial_investment: 5_000_000 });
  await store.update("franchise_applications", String(app.ROWID), { feasibility_id: String(fm.ROWID) });
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "IN_PROGRESS", target_opening_date: "2026-10-30" });
  const bills: BooksBill[] = [];
  const books = { listBills: async (text: string) => bills.filter((b) => b.reference.includes(text)) } as any;
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => NOW, zoho: async () => ({ books }) as any });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}/capex`;
  const capex = async (ext = "pm") => (await call(ext, "GET", base)).data;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, project, bills, books, call, base, capex, inbox };
}

const pdf = { file_name: "invoice.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 inv").toString("base64") };
const bill = (id: string, reference: string, total: number, status = "open"): BooksBill => ({ id, number: `BILL-${id}`, reference, vendor: "Hobart India", date: "2026-10-01", status, total, balance: status === "paid" ? 0 : total });

describe("capex budget vs actual", () => {
  it("splits the feasibility investment into budget lines once", async () => {
    const s = await setup();
    const c = await s.capex();
    expect(c.budget).toBe(5_000_000);
    expect(c.rows.find((r: any) => r.category === "KITCHEN")).toMatchObject({ name: "Kitchen equipment", budget: 1_250_000, actual: 0, over: false });
    expect(c.books_connected).toBe(true);
    await s.capex();
    expect(await s.store.findMany("capex_lines", {})).toHaveLength(9);
  });

  it("pulls Books bills tagged with the project code, keeps a recategorisation and drops voided bills", async () => {
    const s = await setup();
    s.bills.push(bill("1", "PROJ-000001 KITCHEN", 900_000), bill("2", "PROJ-000001/Signage and branding", 200_000, "paid"), bill("3", "PROJ-000001", 50_000), bill("4", "PROJ-000002 KITCHEN", 1));
    expect((await s.call("pm", "POST", `${s.base}/sync`)).data).toEqual({ added: 3, updated: 0, bills: 3 });
    let c = await s.capex();
    expect(c.rows.find((r: any) => r.category === "KITCHEN")).toMatchObject({ actual: 900_000, outstanding: 900_000 });
    expect(c.rows.find((r: any) => r.category === "SIGNAGE")).toMatchObject({ actual: 200_000, outstanding: 0 });
    expect(c.rows.find((r: any) => r.category === "OTHER")).toMatchObject({ actual: 50_000, budget: 0 });

    const untagged = c.spend.find((x: any) => x.external_id === "3");
    await s.call("pm", "PATCH", `${s.base}/spend/${untagged.ROWID}`, { category: "IT" });
    expect((await s.call("pm", "PATCH", `${s.base}/spend/${untagged.ROWID}`, { void: true })).error?.code).toBe("VALIDATION_FAILED");
    s.bills[0] = { ...s.bills[0], status: "void" };
    s.bills[2] = { ...s.bills[2], status: "paid", balance: 0 };
    expect((await s.call("pm", "POST", `${s.base}/sync`)).data).toMatchObject({ added: 0, updated: 2 });
    c = await s.capex();
    expect(c.rows.find((r: any) => r.category === "KITCHEN").actual).toBe(0);
    expect(c.rows.find((r: any) => r.category === "IT")).toMatchObject({ actual: 50_000, outstanding: 0 });
    expect(c.actual).toBe(250_000);
  });

  it("tells finance and the project manager once when a category goes over budget", async () => {
    const s = await setup();
    s.bills.push(bill("1", "PROJ-000001 KITCHEN", 1_300_000));
    await s.call("pm", "POST", `${s.base}/sync`);
    expect(await s.inbox("fin")).toEqual(["Kitchen equipment is over budget on PROJ-000001"]);
    s.bills.push(bill("2", "PROJ-000001 KITCHEN", 10_000));
    await s.call("pm", "POST", `${s.base}/sync`);
    expect(await s.inbox("fin")).toHaveLength(1);
    // Raising the budget clears it; going over again alerts again.
    const line = (await s.capex()).lines.find((l: any) => l.category === "KITCHEN");
    await s.call("pm", "PATCH", `${s.base}/lines/${line.ROWID}`, { budget: 1_400_000 });
    expect((await s.capex()).rows.find((r: any) => r.category === "KITCHEN").over).toBe(false);
    await s.call("pm", "POST", `${s.base}/spend`, { category: "KITCHEN", vendor: "Local fabricator", spend_date: "2026-10-05", amount: 100_000 });
    expect(await s.inbox("fin")).toHaveLength(2);
  });

  it("the franchisee records spend with an invoice; staff can void it; finance can't edit", async () => {
    const s = await setup();
    const body = { category: "FURNITURE", vendor: "Godrej Interio", spend_date: "2026-10-02", amount: 120_000 };
    expect((await s.call("pepper", "POST", `${s.base}/spend`, body)).error?.fields).toEqual({ invoice: "required" });
    const added = await s.call("pepper", "POST", `${s.base}/spend`, { ...body, invoice: pdf });
    expect(added.data).toMatchObject({ source: "PORTAL", status: "RECORDED", amount: 120_000 });
    expect((await s.call("pm", "GET", `${s.base}/spend/${added.data.ROWID}/invoice`)).data.url).toMatch(/^memory:/);
    expect((await s.capex("pepper")).actual).toBe(120_000);
    expect((await s.call("pepper", "PATCH", `${s.base}/spend/${added.data.ROWID}`, { void: true })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("fin", "POST", `${s.base}/spend`, body)).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pm", "POST", `${s.base}/spend`, { ...body, spend_date: "2026-12-01" })).error?.fields).toEqual({ spend_date: "can't be in the future" });
    await s.call("pm", "PATCH", `${s.base}/spend/${added.data.ROWID}`, { void: true });
    expect((await s.capex()).actual).toBe(0);
  });

  it("the daily sync pulls bills for every open project", async () => {
    const s = await setup();
    s.bills.push(bill("9", "PROJ-000001 CIVIL", 400_000));
    const out = await runTwoWaySyncJob(s.store, async () => ({ books: { ...s.books, getInvoice: async () => { throw new Error("no"); } }, crm: { getContact: async () => ({}), getAccount: async () => ({}) } }) as any, { now: NOW, requestId: "J1" });
    expect(out.bills_added).toBe(1);
    expect((await s.capex()).rows.find((r: any) => r.category === "CIVIL").actual).toBe(400_000);
  });

  it("reads the category from the bill reference", () => {
    const lines = [{ category: "KITCHEN", name: "Kitchen equipment" }, { category: "IT", name: "IT and POS" }];
    expect(categoryFromReference("proj-000001 - it", "PROJ-000001", lines)).toBe("IT");
    expect(categoryFromReference("PROJ-000001: Kitchen equipment phase 2", "PROJ-000001", lines)).toBe("KITCHEN");
    expect(categoryFromReference("PROJ-000001 misc", "PROJ-000001", lines)).toBe("OTHER");
  });
});
