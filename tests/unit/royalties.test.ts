import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { runReminderJob } from "../../functions/workflows/notifications";
import { runTwoWaySyncJob } from "../../functions/workflows/twoWaySync";
import { newStore } from "./helpers";

const router = buildRouter();

async function setup(opts: { feasibilityRoyalty?: number } = {}) {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", email: "pepper@x.test", status: "ACTIVE", zoho_books_customer_id: "CUST-1" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("SUPER_ADMIN", "tony");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISE_MANAGER", "fm");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  await store.insert("feasibility_models", { tenant_id: tid, application_id: app.ROWID, site_id: "1", status: "CALCULATED", royalty_pct: opts.feasibilityRoyalty ?? 6, marketing_fund_pct: 2 });
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "OPENED", actual_opening_date: "2026-08-20" });
  const invoices = new Map<string, { id: string; ref: string; lines: any[]; status: string; total: number; balance: number }>();
  const sent: string[][] = [];
  const books = {
    findInvoice: async (ref: string) => { const i = [...invoices.values()].find((x) => x.ref === ref); return i ? { id: i.id } : null; },
    createInvoice: async (d: any) => {
      const id = `INV-${invoices.size + 1}`;
      const total = d.line_items.reduce((a: number, l: any) => a + l.rate * l.quantity, 0);
      invoices.set(id, { id, ref: d.reference_number, lines: d.line_items, status: "draft", total, balance: total });
      return { id };
    },
    sendInvoice: async (id: string, to: string[]) => { sent.push(to); invoices.get(id)!.status = "sent"; },
    getInvoice: async (id: string) => { const i = invoices.get(id)!; return { id, number: `INV/${id}`, status: i.status, total: i.total, balance: i.balance, due_date: "2026-10-26", last_payment_date: null }; },
  } as any;
  const deps = (now: string) => ({ store, files, now: () => new Date(now), zoho: async () => ({ books }) as any });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = "2026-10-11T06:00:00Z") => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, deps(now));
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}`;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, project, call, base, inbox, invoices, sent, books };
}

describe("monthly sales and royalties", () => {
  it("lists the months a store owes from its opening month, at its feasibility rates", async () => {
    const s = await setup();
    const l = (await s.call("pepper", "GET", `${s.base}/royalties`)).data;
    expect(l.rates).toEqual({ royalty_pct: 6, marketing_fund_pct: 2, source: "feasibility" });
    expect(l.months.map((m: any) => [m.period, m.due_on, m.late])).toEqual([["2026-09", "2026-10-07", true], ["2026-08", "2026-09-07", true]]);
    expect(l.totals).toMatchObject({ missing: 2, waiting: 0 });
  });

  it("takes a report from the franchisee, with the month's checks", async () => {
    const s = await setup();
    const post = (body: any) => s.call("pepper", "POST", `${s.base}/sales`, body);
    expect((await post({ period: "2026-10", gross_sales: 1, net_sales: 1 })).error?.fields).toEqual({ period: "month not finished yet" });
    expect((await post({ period: "2026-07", gross_sales: 1, net_sales: 1 })).error?.fields).toEqual({ period: "before the store opened" });
    expect((await post({ period: "2026-09", gross_sales: 100, net_sales: 200 })).error?.fields).toEqual({ net_sales: "more than gross" });
    const r = await post({ period: "2026-09", gross_sales: 1_250_000, net_sales: 1_100_000, transactions: 9800, report: { file_name: "pos.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF").toString("base64") } });
    expect(r.data).toMatchObject({ status: "SUBMITTED", source: "PORTAL", net_sales: 1_100_000 });
    expect(await s.inbox("fin")).toEqual(["PROJ-000001 reported Sep 2026 sales"]);
    // Finance can't report sales without royalty.manage; the franchisee can fix it while it waits.
    expect((await s.call("fin", "POST", `${s.base}/sales`, { period: "2026-08", gross_sales: 1, net_sales: 1 })).error?.code).toBe("ACCESS_DENIED");
    expect((await post({ period: "2026-09", gross_sales: 1_250_000, net_sales: 1_150_000 })).data).toMatchObject({ net_sales: 1_150_000, status: "SUBMITTED" });
    expect(await s.store.findMany("sales_reports", {})).toHaveLength(1);
  });

  it("approval raises one Books invoice for royalty and marketing fund, and payment closes it", async () => {
    const s = await setup();
    const rep = (await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 1_250_000, net_sales: 1_100_000 })).data;
    expect((await s.call("fin", "POST", `${s.base}/sales/${rep.ROWID}/approve`)).error?.code).toBe("ACCESS_DENIED");
    const ok = await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`);
    expect(ok.data).toMatchObject({ status: "INVOICED", royalty_amount: 66_000, marketing_amount: 22_000, invoice_number: "INV/INV-1", invoice_status: "sent", invoice_balance: 88_000 });
    const inv = s.invoices.get("INV-1")!;
    expect(inv.ref).toBe("ROY-PROJ-000001-202609");
    expect(inv.lines.map((l) => [l.name, l.rate])).toEqual([["Royalty", 66_000], ["Marketing fund", 22_000]]);
    expect(s.sent).toEqual([["pepper@x.test"]]);
    expect(await s.inbox("pepper")).toContain("Royalty invoice for Sep 2026: ₹88,000");
    // Locked once invoiced.
    expect((await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 1, net_sales: 1 })).error?.code).toBe("INVALID_TRANSITION");
    expect((await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`)).error?.code).toBe("INVALID_TRANSITION");
    inv.status = "paid"; inv.balance = 0;
    const out = await runTwoWaySyncJob(s.store, async () => ({ books: s.books, crm: { getContact: async () => ({}), getAccount: async () => ({}) } }) as any, { now: new Date("2026-10-20T00:30:00Z"), requestId: "J" });
    expect(out.royalties_paid).toBe(1);
    const l = (await s.call("tony", "GET", `${s.base}/royalties`)).data;
    expect(l.months[0].report).toMatchObject({ status: "PAID" });
    expect(l.totals).toMatchObject({ royalty: 66_000, marketing: 22_000, outstanding: 0, missing: 1 });
  });

  it("returns a report with a note, and needs a rate before approving", async () => {
    const s = await setup();
    await s.store.update("feasibility_models", String((await s.store.findMany("feasibility_models", {}))[0].ROWID), { royalty_pct: null });
    const rep = (await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 100, net_sales: 90 })).data;
    expect((await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`)).error?.fields).toEqual({ royalty_pct: "not set" });
    expect((await s.call("tony", "PATCH", `${s.base}/royalty-rates`, { royalty_pct: 5, marketing_fund_pct: 0 })).data).toMatchObject({ royalty_pct: 5 });
    const back = await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/return`, { note: "Net sales exclude GST; please re-check." });
    expect(back.data).toMatchObject({ status: "RETURNED" });
    expect(await s.inbox("pepper")).toContain("Your Sep 2026 sales report for PROJ-000001 needs a correction");
    const fixed = await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 100, net_sales: 80 });
    expect(fixed.data.status).toBe("SUBMITTED");
    expect((await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`)).data).toMatchObject({ royalty_amount: 4, marketing_amount: 0 });
    expect(s.invoices.get("INV-1")!.lines).toHaveLength(1);
  });

  it("reminds the franchisee on the due day, and finance once it is late", async () => {
    const s = await setup();
    await s.store.update("franchise_projects", String(s.project.ROWID), { actual_opening_date: "2026-09-03" });
    await runReminderJob(s.store, { now: new Date("2026-10-06T03:00:00Z"), requestId: "J" });
    expect((await s.inbox("pepper")).filter((t) => t.includes("sales"))).toEqual([]);
    await runReminderJob(s.store, { now: new Date("2026-10-07T03:00:00Z"), requestId: "J" });
    expect((await s.inbox("pepper")).filter((t) => t.includes("sales"))).toEqual(["Report your Sep 2026 sales for PROJ-000001"]);
    expect((await s.inbox("fin")).filter((t) => t.includes("sales"))).toEqual([]);
    await runReminderJob(s.store, { now: new Date("2026-10-12T03:00:00Z"), requestId: "J" });
    expect((await s.inbox("pepper")).filter((t) => t.includes("sales"))).toHaveLength(1);
    expect((await s.inbox("fin")).filter((t) => t.includes("sales"))).toEqual(["PROJ-000001 hasn't reported Sep 2026 sales"]);
  });

  it("gives finance a network view", async () => {
    const s = await setup();
    await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 10, net_sales: 10 });
    const r = (await s.call("fin", "GET", "/royalties")).data;
    expect(r.items).toMatchObject([{ period: "2026-09", label: "Sep 2026", project_code: "PROJ-000001", franchisee: "Pepper Potts", status: "SUBMITTED" }]);
    expect(r.totals).toMatchObject({ stores: 1, waiting: 1 });
    expect((await s.call("pepper", "GET", "/royalties")).error?.code).toBe("ACCESS_DENIED");
  });
});
