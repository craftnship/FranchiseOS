import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { feePlan, signingFee } from "../../functions/workflows/agreements";
import { runReminderJob } from "../../functions/workflows/notifications";
import { runTwoWaySyncJob } from "../../functions/workflows/twoWaySync";
import { newStore } from "./helpers";

const router = buildRouter();
const pdf = { file_name: "sanction.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 s").toString("base64") };
const PLAN = { franchise_fee: 500000, fee_plan: [{ label: "On signing", pct: 40, trigger: "SIGNING" }, { label: "At fit-out", pct: 30, trigger: "TASK", task: "FITOUT" }, { label: "On opening", pct: 30, trigger: "OPENING" }], security_deposit: 100000 };

async function setup(opts: { legacy?: boolean } = {}) {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  await store.update("tenants", tid, { settings_json: JSON.stringify(PLAN) });
  const tenant = await store.findOne("tenants", { ROWID: tid });
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", email: "pepper@x.test", status: "ACTIVE", zoho_books_customer_id: "CUST-1" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("SUPER_ADMIN", "tony");
  await user("FINANCE_MANAGER", "fin");
  await user("PROJECT_MANAGER", "pm");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  const fm = await store.insert("feasibility_models", { tenant_id: tid, application_id: "0", site_id: "1", status: "CALCULATED", initial_investment: 4_000_000 });
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "ACTIVE", feasibility_id: fm.ROWID });
  const agreement = await store.insert("agreements", {
    tenant_id: tid, agreement_code: "AGR-000001", tenant_code_key: `${tid}:AGR-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", signed_at: "2026-09-01T10:00:00Z",
    zoho_books_invoice_id: "INV-SIGN", fee_status: "SENT", fee_total: 236000, fee_balance: 236000, fee_due_date: "2026-09-16",
    fee_plan_json: opts.legacy ? null : JSON.stringify(feePlan(tenant)),
  });
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: "1", status: "IN_PROGRESS", target_opening_date: "2026-12-15" });
  const fitout = await store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: "FITOUT", item: "Complete fit-out", category: "CONSTRUCTION", weight: 3, mandatory: true, status: "OPEN", due_date: "2026-11-01" });
  const invoices = new Map<string, { id: string; ref: string; lines: any[]; status: string; total: number; balance: number; customer_id?: string }>();
  invoices.set("INV-SIGN", { id: "INV-SIGN", ref: "FEE-STARK-AGR-000001", lines: [], status: "sent", total: 236000, balance: 236000, customer_id: "CUST-1" });
  const books = {
    findCustomer: async () => null, createCustomer: async () => ({ id: "CUST-NEW" }),
    findInvoice: async (ref: string) => { const i = [...invoices.values()].find((x) => x.ref === ref); return i ? { id: i.id, customer_id: i.customer_id, total: i.total, status: i.status } : null; },
    createInvoice: async (d: any) => {
      const id = `INV-${invoices.size + 1}`;
      const total = d.line_items.reduce((a: number, l: any) => a + l.rate * l.quantity, 0);
      invoices.set(id, { id, ref: d.reference_number, lines: d.line_items, status: "draft", total, balance: total, customer_id: d.customer_id });
      return { id };
    },
    sendInvoice: async (id: string) => { invoices.get(id)!.status = "sent"; },
    getInvoice: async (id: string) => { const i = invoices.get(id)!; return { id, number: `INV/${id}`, status: i.status, total: i.total, balance: i.balance, due_date: "2026-10-25", last_payment_date: i.balance <= 0 ? "2026-10-20" : null }; },
  } as any;
  const call = async (ext: string, method: string, path: string, body?: unknown, now = "2026-10-11T06:00:00Z", query?: Record<string, string>) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => new Date(now), zoho: async () => ({ books }) as any });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
  };
  const job = (now: string) => runTwoWaySyncJob(store, async () => ({ books, crm: { getContact: async () => ({}), getAccount: async () => ({}), updateAccount: async () => ({}) } }) as any, { now: new Date(now), requestId: "J" });
  const base = `/projects/${project.ROWID}`;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, tenant, project, agreement, fitout, call, job, base, inbox, invoices };
}

describe("franchise fee schedule", () => {
  it("splits the fee by the tenant's plan; signing takes only its share", async () => {
    const s = await setup();
    const plan = feePlan(s.tenant);
    expect(plan.map((p) => [p.kind, p.amount, p.trigger])).toEqual([["FEE", 200000, "SIGNING"], ["FEE", 150000, "TASK"], ["FEE", 150000, "OPENING"], ["DEPOSIT", 100000, "SIGNING"]]);
    expect(signingFee(plan)).toBe(200000);
    // Without a plan the whole fee is invoiced on signing, as before.
    expect(signingFee(feePlan({ settings_json: JSON.stringify({ franchise_fee: 300000 }) }))).toBe(300000);
  });

  it("raises each instalment when it falls due, and follows payment back from Books", async () => {
    const s = await setup();
    // Only fee.manage changes the schedule; the franchisee can see it.
    const f = (await s.call("pepper", "GET", `${s.base}/funding`)).data;
    expect(f.instalments.map((i: any) => [i.label, i.amount, i.status, i.due_now, i.signing_invoice])).toEqual([
      ["On signing", 200000, "INVOICED", false, true], ["At fit-out", 150000, "SCHEDULED", false, false], ["On opening", 150000, "SCHEDULED", false, false], ["Security deposit", 100000, "SCHEDULED", true, false],
    ]);
    expect(f.instalments[1].when).toBe("When “Complete fit-out” is done");
    expect(f.totals).toMatchObject({ fee: 500000, deposit: 100000, outstanding: 236000 });
    const fitoutFee = f.instalments[1];
    expect((await s.call("fin", "PATCH", `${s.base}/fees/${fitoutFee.ROWID}`, { action: "raise" })).error?.code).toBe("ACCESS_DENIED");

    // The daily job raises the deposit (due on signing) without tax, and leaves the rest.
    expect(await s.job("2026-10-12T00:30:00Z")).toMatchObject({ instalments_raised: 1 });
    const deposit = [...s.invoices.values()].find((i) => i.ref === "FEE-STARK-AGR-000001-4")!;
    expect(deposit.lines).toEqual([expect.objectContaining({ name: "Security deposit", rate: 100000 })]);
    expect(deposit.lines[0].tax_id).toBeUndefined();
    expect(await s.inbox("pepper")).toEqual(["Security deposit invoiced for ₹1,00,000 (INV/INV-2)"]);

    // Fit-out done: the next run raises that instalment.
    await s.store.update("opening_checklists", String(s.fitout.ROWID), { status: "COMPLETED" });
    expect(await s.job("2026-10-13T00:30:00Z")).toMatchObject({ instalments_raised: 1 });
    expect([...s.invoices.values()].map((i) => i.ref)).toEqual(["FEE-STARK-AGR-000001", "FEE-STARK-AGR-000001-4", "FEE-STARK-AGR-000001-2"]);

    // Paid in Books: finance hears about it once.
    s.invoices.get("INV-2")!.balance = 0;
    expect(await s.job("2026-10-21T00:30:00Z")).toMatchObject({ instalments_paid: 1 });
    expect(await s.inbox("fin")).toEqual(["PROJ-000001 paid the security deposit (₹1,00,000)"]);
    expect(await s.job("2026-10-22T00:30:00Z")).toMatchObject({ instalments_paid: 0, instalments_raised: 0 });

    // Overdue, on the collections ladder (both invoices read as due 25 Oct from the fake Books): the franchisee is
    // reminded of each; staff join at the later steps.
    const rem = await runReminderJob(s.store, { now: new Date("2026-10-27T03:00:00Z"), requestId: "R" });
    expect(rem).toMatchObject({ fees: 2, collections: 0 });
    expect((await s.inbox("pepper")).slice(0, 2).sort()).toEqual(["₹1,50,000 for at fit-out is 2 days overdue", "₹2,36,000 for the franchise fee is 2 days overdue"]);
    expect((await s.inbox("fin"))[0]).toBe("PROJ-000001 paid the security deposit (₹1,00,000)");

    // The deposit is refunded later; a scheduled instalment can be waived, not an invoiced one.
    const after = (await s.call("tony", "GET", `${s.base}/funding`, undefined, "2026-10-27T06:00:00Z")).data;
    const [, fit, open, dep] = after.instalments;
    expect((await s.call("tony", "PATCH", `${s.base}/fees/${fit.ROWID}`, { action: "waive", note: "Goodwill" })).error?.code).toBe("INVALID_TRANSITION");
    expect((await s.call("tony", "PATCH", `${s.base}/fees/${open.ROWID}`, { action: "waive", note: "Waived for the pilot" })).data.status).toBe("WAIVED");
    expect((await s.call("tony", "PATCH", `${s.base}/fees/${dep.ROWID}`, { action: "refund", refunded_on: "2026-10-26" }, "2026-10-27T06:00:00Z")).data).toMatchObject({ status: "REFUNDED", refunded_on: "2026-10-26" });
    const net = (await s.call("fin", "GET", "/fees", undefined, "2026-10-27T06:00:00Z")).data;
    expect(net.items).toHaveLength(4);
    expect(net.totals).toMatchObject({ scheduled: 0, outstanding: 236000 + 150000, overdue: 2 });
  });

  it("lets fee.manage add and change instalments, checked against the store's tasks", async () => {
    const s = await setup();
    await s.call("tony", "GET", `${s.base}/funding`);
    const bad = await s.call("tony", "POST", `${s.base}/fees`, { kind: "FEE", label: "Training", amount: 50000, raise_on: "TASK", task_code: "NOPE" });
    expect(bad.error?.fields).toEqual({ task_code: "not a task of this store" });
    expect((await s.call("tony", "POST", `${s.base}/fees`, { kind: "FEE", label: "Training", amount: 50000, raise_on: "DATE" })).error?.fields).toEqual({ due_on: "required" });
    const added = (await s.call("tony", "POST", `${s.base}/fees`, { kind: "FEE", label: "Training", amount: 50000, raise_on: "DATE", due_on: "2026-11-15" })).data;
    expect(added).toMatchObject({ seq: 5, status: "SCHEDULED", raise_on: "DATE" });
    const edited = (await s.call("tony", "PATCH", `${s.base}/fees/${added.ROWID}`, { action: "edit", kind: "FEE", label: "Training fee", amount: 60000, raise_on: "DATE", due_on: "2026-10-01" })).data;
    expect(edited).toMatchObject({ amount: 60000, due_on: "2026-10-01" });
    expect((await s.call("tony", "GET", `${s.base}/funding`)).data.instalments[4]).toMatchObject({ due_now: true });
    expect((await s.call("tony", "PATCH", `${s.base}/fees/${added.ROWID}`, { action: "raise" })).data).toMatchObject({ status: "INVOICED", invoice_ref: "FEE-STARK-AGR-000001-5", invoice_number: "INV/INV-2" });
    expect((await s.call("tony", "PATCH", `${s.base}/fees/${added.ROWID}`, { action: "edit", kind: "FEE", label: "x1", amount: 1, raise_on: "SIGNING" })).error?.code).toBe("INVALID_TRANSITION");
  });

  it("gives an agreement signed before schedules only its one fee invoice", async () => {
    const s = await setup({ legacy: true });
    const f = (await s.call("pepper", "GET", `${s.base}/funding`)).data;
    expect(f.instalments.map((i: any) => [i.label, i.amount, i.status])).toEqual([["Franchise fee", 500000, "INVOICED"]]);
    // Nothing new is billed to a store signed before the plan, by the nightly run either.
    expect(await s.job("2026-10-12T00:30:00Z")).toMatchObject({ instalments_raised: 0 });
  });
});

describe("franchisee funding", () => {
  it("tracks the loan from plan to disbursement against the capex budget", async () => {
    const s = await setup();
    const patch = (ext: string, body: any, now?: string) => s.call(ext, "PATCH", `${s.base}/funding`, body, now);
    expect((await patch("pepper", { action: "applied", lender: "SBI", applied_on: "2026-09-10" })).error?.message).toBe("Set the funding plan first.");
    expect((await patch("pepper", { action: "plan", own_capital: 1_500_000, loan_amount: 2_500_000 })).data.status).toBe("PLANNED");
    let f = (await s.call("pm", "GET", `${s.base}/funding`)).data.funding;
    expect(f).toMatchObject({ investment: 4_000_000, planned: 4_000_000, secured: 1_500_000, gap: 2_500_000, planned_gap: 0 });

    // Fit-out is three weeks out and the loan isn't sanctioned: everyone hears once.
    expect((await runReminderJob(s.store, { now: new Date("2026-10-11T03:00:00Z"), requestId: "R" })).funding).toBe(3);
    expect((await runReminderJob(s.store, { now: new Date("2026-10-12T03:00:00Z"), requestId: "R" })).funding).toBe(0);

    expect((await patch("pepper", { action: "applied", lender: "SBI", applied_on: "2026-10-12" })).error?.fields).toEqual({ applied_on: "can't be in the future" });
    await patch("pepper", { action: "applied", lender: "SBI", applied_on: "2026-09-10", loan_ref: "SBI/HL/88" });
    expect((await patch("pepper", { action: "rejected", reason: "Short of collateral" })).data.status).toBe("REJECTED");
    expect(await s.inbox("fin")).toContain("PROJ-000001: the loan from SBI was rejected");
    await patch("pepper", { action: "applied", lender: "HDFC Bank", applied_on: "2026-09-20" });
    const sanctioned = (await patch("pm", { action: "sanctioned", sanctioned_on: "2026-10-05", sanctioned_amount: 2_000_000, interest_pct: 10.5, tenure_months: 60, letter: pdf })).data;
    expect(sanctioned).toMatchObject({ status: "SANCTIONED", lender: "HDFC Bank", sanctioned_amount: 2_000_000 });
    expect((await s.call("pepper", "GET", `${s.base}/funding/sanction-letter`)).data.url).toBeTruthy();
    expect(await s.inbox("fin")).toContain("PROJ-000001: HDFC Bank sanctioned ₹20,00,000");
    // The plan's loan is locked once sanctioned; own capital can still grow to close the gap.
    expect((await patch("pepper", { action: "plan", own_capital: 1_500_000, loan_amount: 3_000_000 })).error?.code).toBe("INVALID_TRANSITION");
    await patch("pepper", { action: "plan", own_capital: 2_000_000, loan_amount: 2_500_000 });
    f = (await s.call("pm", "GET", `${s.base}/funding`)).data.funding;
    expect(f).toMatchObject({ secured: 4_000_000, gap: 0, secured_pct: 100 });

    expect((await patch("pepper", { action: "disbursed", amount: 1_200_000, disbursed_on: "2026-10-01" })).error?.fields).toEqual({ disbursed_on: "before the sanction" });
    expect((await patch("pepper", { action: "disbursed", amount: 1_200_000, disbursed_on: "2026-10-08" })).data.status).toBe("DISBURSING");
    expect((await patch("pepper", { action: "disbursed", amount: 900_000, disbursed_on: "2026-10-09" })).error?.fields).toEqual({ amount: "more than the sanction left" });
    expect((await patch("pepper", { action: "disbursed", amount: 800_000, disbursed_on: "2026-10-10" })).data).toMatchObject({ status: "DISBURSED", disbursed_amount: 2_000_000 });
    const plan = (await s.call("pepper", "GET", `${s.base}/funding`)).data.plan;
    expect(plan.disbursements.map((d: any) => d.amount)).toEqual([1_200_000, 800_000]);
  });
});
