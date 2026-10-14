import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { paymentsScore, scoreHealth } from "../../functions/scoring/health";
import { DEFAULT_LADDER, normaliseLadder, paymentBehaviour, stepDue } from "../../functions/workflows/collections";
import { runReminderJob } from "../../functions/workflows/notifications";
import { computeNetworkHealth } from "../../functions/workflows/storeHealth";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = "2026-10-11T06:00:00Z";

async function setup(opts: { settings?: Record<string, unknown> } = {}) {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  if (opts.settings) {
    const tenant = (await store.findOne("tenants", { ROWID: tid }))!;
    await store.update("tenants", tid, { settings_json: JSON.stringify({ ...JSON.parse(String(tenant.settings_json ?? "{}")), ...opts.settings }) });
  }
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  const user = (role: string, ext: string, extra: Record<string, unknown> = {}) => ins("users", { email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, ...extra });
  await user("SUPER_ADMIN", "tony");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISE_MANAGER", "fm");
  await user("FRANCHISE_DIRECTOR", "dir");
  const fr = await ins("franchisees", { franchise_code: "FR-1", tenant_code_key: `${tid}:FR-1`, display_name: "Pepper Potts", email: "pepper@x.test", status: "ACTIVE", zoho_books_customer_id: "CUST-1" });
  await user("FRANCHISEE", "pepper", { franchisee_id: fr.ROWID });
  const app = await ins("franchise_applications", { application_code: "APP-1", tenant_code_key: `${tid}:APP-1`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  await ins("feasibility_models", { application_id: app.ROWID, site_id: "1", status: "CALCULATED", royalty_pct: 6, marketing_fund_pct: 2, monthly_revenue: 1_000_000 });
  const agreement = await ins("agreements", { agreement_code: "AGR-1", tenant_code_key: `${tid}:AGR-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", signed_at: "2026-06-01T10:00:00Z", zoho_books_invoice_id: "INV-0", fee_status: "PAID", fee_total: 500_000, fee_balance: 0, fee_paid_on: "2026-06-11" });
  const project = await ins("franchise_projects", { project_code: "PROJ-1", tenant_code_key: `${tid}:PROJ-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "OPENED", actual_opening_date: "2026-09-01" });
  // Books as the fake sees it: invoice balances that payments reduce.
  const invoices = new Map<string, { number: string; total: number; balance: number; due: string; paid?: string }>([
    ["INV-1", { number: "INV/1", total: 60_000, balance: 60_000, due: "2026-10-15" }],
    ["INV-2", { number: "INV/2", total: 200_000, balance: 200_000, due: "2026-09-20" }],
  ]);
  const payments: any[] = [];
  const books = {
    getInvoice: async (id: string) => { const i = invoices.get(id)!; return { id, number: i.number, status: i.balance <= 0 ? "paid" : "sent", total: i.total, balance: i.balance, due_date: i.due, last_payment_date: i.paid ?? null }; },
    recordPayment: async (d: any) => { payments.push(d); for (const x of d.invoices) { const i = invoices.get(x.invoice_id)!; i.balance -= x.amount_applied; i.paid = d.date; } return { id: `PAY-${payments.length}`, number: `CP-${payments.length}` }; },
  } as any;
  // September's royalty, invoiced on 1 Oct and due 15 Oct; a fit-out instalment due 20 Sep, already late.
  const report = await ins("sales_reports", { project_id: project.ROWID, franchisee_id: fr.ROWID, period: "2026-09", period_key: `${tid}:${project.ROWID}:2026-09`, status: "INVOICED", net_sales: 750_000, royalty_amount: 45_000, marketing_amount: 15_000, zoho_books_invoice_id: "INV-1", invoice_number: "INV/1", invoice_total: 60_000, invoice_balance: 60_000, invoice_due_date: "2026-10-15", reviewed_at: "2026-10-01T05:00:00Z" });
  const instalment = await ins("fee_instalments", { project_id: project.ROWID, agreement_id: agreement.ROWID, franchisee_id: fr.ROWID, seq: 2, instalment_key: `${tid}:${agreement.ROWID}:2`, kind: "FEE", label: "At fit-out", amount: 200_000, raise_on: "TASK", status: "INVOICED", zoho_books_invoice_id: "INV-2", invoice_number: "INV/2", invoice_total: 200_000, invoice_balance: 200_000, invoice_due_date: "2026-09-20", invoiced_on: "2026-09-05" });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = NOW, query: Record<string, string> = {}) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now), zoho: async () => ({ books }) as any });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string>; message?: string } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  const remind = (now: string) => runReminderJob(store, { now: new Date(now), requestId: "R" });
  const list = async (status = "", now = NOW) => (await call("fin", "GET", "/collections", undefined, now, status ? { status } : {})).data;
  return { store, tid, fr, project, report, instalment, call, inbox, remind, list, payments, invoices };
}

describe("collections: the ladder", () => {
  it("chases an invoice step by step, each step once, and jumps a late invoice to the step its age has reached", async () => {
    const s = await setup();
    // 12 Oct: the royalty is due in 3 days (step −3); the instalment is 22 days late and lands on step 15 only.
    let r = await s.remind("2026-10-12T03:00:00Z");
    expect(r).toMatchObject({ fees: 2, collections: 1 });
    expect((await s.inbox("pepper")).sort()).toEqual(["₹2,00,000 for at fit-out is 22 days overdue", "₹60,000 for Sep 2026 royalty is due 15 Oct 2026"]);
    expect(await s.inbox("fin")).toEqual(["PROJ-1: ₹2,00,000 for at fit-out is 22 days late"]);
    expect(await s.inbox("fm")).toEqual([]);
    // The same day again: nothing new.
    expect(await s.remind("2026-10-12T09:00:00Z")).toMatchObject({ fees: 0, collections: 0 });
    // Due day, then 7 days late: the franchise manager joins.
    await s.remind("2026-10-15T03:00:00Z");
    expect((await s.inbox("pepper"))[0]).toBe("₹60,000 for Sep 2026 royalty is due today");
    await s.remind("2026-10-22T03:00:00Z");
    expect((await s.inbox("pepper"))[0]).toBe("₹60,000 for Sep 2026 royalty is 7 days overdue");
    expect(await s.inbox("fm")).toEqual(["PROJ-1: ₹60,000 for Sep 2026 royalty is 7 days late"]);
    // 30 days late: the director hears, the item is flagged, the franchisee is not written to on that step.
    r = await s.remind("2026-11-14T03:00:00Z");
    expect((await s.inbox("dir")).sort()).toEqual(["PROJ-1: ₹2,00,000 for at fit-out is 32 days late, escalated", "PROJ-1: ₹60,000 for Sep 2026 royalty is 30 days late, escalated"]);
    const d = await s.list("", "2026-11-14T06:00:00Z");
    expect(d.items.map((i: any) => [i.kind, i.step, i.escalated, i.days_late])).toEqual([["INSTALMENT", 4, true, 55], ["ROYALTY", 4, true, 30]]);
    expect(d.totals).toMatchObject({ open: 260_000, overdue: 260_000, count: 2, escalated: 2 });
    // The store's health shows the escalation and the dashboard says so.
    const h = await computeNetworkHealth(s.store, { tenantId: s.tid }, "2026-11-14");
    expect(h.stores[0].inputs.payments).toMatchObject({ escalated: true, oldest_days: 55 });
    expect(h.stores[0].reasons.find((x) => x.part === "payments")?.text).toBe("Payment escalated, 55 days overdue");
    const o = (await s.call("fin", "GET", "/dashboard/owner", undefined, "2026-11-14T06:00:00Z")).data;
    expect(o.attention.items.filter((i: any) => i.kind === "Collection").map((i: any) => i.title)).toEqual(["PROJ-1 at fit-out 55 days late, escalated", "PROJ-1 Sep 2026 royalty 30 days late, escalated"]);
    expect(o.receivables.collections).toMatchObject({ open: 2, escalated: 2, broken_promises: 0, rate_pct: 0, billed_90d: 260_000, collected_90d: 0 });
  });

  it("holds the ladder for a promise, tells finance when it is broken, and pauses on a dispute", async () => {
    const s = await setup();
    await s.remind("2026-10-12T03:00:00Z");
    const d = await s.list();
    const inst = d.items.find((i: any) => i.kind === "INSTALMENT");
    // Finance may read the list but not act; the super admin acts.
    expect((await s.call("fin", "POST", `/collections/${inst.ROWID}/promise`, { date: "2026-10-20", note: "Cheque on the way" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("tony", "POST", `/collections/${inst.ROWID}/promise`, { date: "2026-10-01" })).error?.fields).toEqual({ date: "in the past" });
    const p = (await s.call("tony", "POST", `/collections/${inst.ROWID}/promise`, { date: "2026-10-20", note: "Cheque on the way" })).data;
    expect(p).toMatchObject({ status: "PROMISED", promise_date: "2026-10-20", promise_broken: false });
    // Still promised: no step goes out even though 30 days late comes on 20 Oct.
    await s.remind("2026-10-20T03:00:00Z");
    expect(await s.inbox("dir")).toEqual([]);
    // The day after: broken, finance hears once, and the ladder resumes with the escalation.
    const r = await s.remind("2026-10-21T03:00:00Z");
    expect(r).toMatchObject({ fees: 1, collections: 2 }); // the director and finance both hear the escalation
    expect(await s.inbox("fin")).toEqual(["PROJ-1: ₹2,00,000 for at fit-out is 31 days late, escalated", "PROJ-1 missed the promised payment of ₹2,00,000", "PROJ-1: ₹2,00,000 for at fit-out is 22 days late"]);
    expect((await s.list("", "2026-10-21T06:00:00Z")).items.find((i: any) => i.kind === "INSTALMENT")).toMatchObject({ status: "OPEN", promise_broken: true, escalated: true });
    const o = (await s.call("fin", "GET", "/dashboard/owner", undefined, "2026-10-21T06:00:00Z")).data;
    expect(o.receivables.collections).toMatchObject({ broken_promises: 1, escalated: 1 });
    // A dispute stops the chase; a note is kept; resuming starts it again.
    const dsp = (await s.call("tony", "POST", `/collections/${inst.ROWID}/dispute`, { reason: "Fit-out not signed off yet" })).data;
    expect(dsp).toMatchObject({ status: "DISPUTED", dispute_reason: "Fit-out not signed off yet" });
    await s.call("tony", "POST", `/collections/${inst.ROWID}/note`, { note: "Called Pepper, meeting Friday" });
    expect((await s.list("DISPUTED")).items[0]).toMatchObject({ last_contact_note: "Called Pepper, meeting Friday" });
    expect((await s.call("tony", "POST", `/collections/${inst.ROWID}/resume`, {})).data.status).toBe("OPEN");
    expect((await s.call("tony", "POST", `/collections/${inst.ROWID}/resume`, {})).error?.code).toBe("INVALID_TRANSITION");
    const log = (await s.call("tony", "GET", "/audit", undefined, NOW, { entity_type: "collection" })).data.items.map((a: any) => a.action);
    expect(log).toEqual(expect.arrayContaining(["collection:promise", "collection:disputed", "collection:note", "collection:resumed"]));
  });

  it("sends a reminder on demand", async () => {
    const s = await setup();
    const d = await s.list();
    const roy = d.items.find((i: any) => i.kind === "ROYALTY");
    expect((await s.call("tony", "POST", `/collections/${roy.ROWID}/remind`)).data).toEqual({ sent: 1 });
    expect((await s.call("tony", "POST", `/collections/${roy.ROWID}/remind`, undefined, "2026-10-11T07:00:00Z")).data).toEqual({ sent: 1 });
    expect(await s.inbox("pepper")).toEqual(["₹60,000 for Sep 2026 royalty is due 15 Oct 2026", "₹60,000 for Sep 2026 royalty is due 15 Oct 2026"]);
    expect((await s.list()).items.find((i: any) => i.kind === "ROYALTY")).toMatchObject({ reminders_sent: 2, last_contact_note: "Reminder sent" });
  });
});

describe("collections: payments", () => {
  it("records a bank transfer in Books, closes the report and the item, and measures how long it took", async () => {
    const s = await setup();
    const roy = (await s.list()).items.find((i: any) => i.kind === "ROYALTY");
    expect((await s.call("tony", "POST", `/collections/${roy.ROWID}/payment`, { amount: 70_000, paid_on: "2026-10-10", mode: "banktransfer" })).error?.fields).toEqual({ amount: "more than the balance" });
    expect((await s.call("tony", "POST", `/collections/${roy.ROWID}/payment`, { amount: 60_000, paid_on: "2026-10-12", mode: "banktransfer" })).error?.fields).toEqual({ paid_on: "in the future" });
    const paid = (await s.call("tony", "POST", `/collections/${roy.ROWID}/payment`, { amount: 60_000, paid_on: "2026-10-10", mode: "banktransfer", reference: "UTR123" })).data;
    expect(s.payments[0]).toMatchObject({ customer_id: "CUST-1", payment_mode: "banktransfer", amount: 60_000, date: "2026-10-10", reference_number: "UTR123", invoices: [{ invoice_id: "INV-1", amount_applied: 60_000 }] });
    expect(paid).toMatchObject({ status: "PAID", paid_on: "2026-10-10", days_to_pay: 9, amount: 0 });
    expect(await s.store.findOne("sales_reports", { ROWID: String(s.report.ROWID) })).toMatchObject({ status: "PAID", paid_on: "2026-10-10", invoice_balance: 0 });
    expect((await s.call("tony", "POST", `/collections/${roy.ROWID}/payment`, { amount: 1, paid_on: "2026-10-10", mode: "cash" })).error?.code).toBe("INVALID_TRANSITION");
    // Behaviour: ₹2.6 L billed in the window, ₹60k collected; the store paid in 9 days.
    const d = await s.list();
    expect(d.totals).toMatchObject({ count: 1, rate_pct: 23.1, days_to_pay: 9, billed_90d: 260_000, collected_90d: 60_000 });
    const o = (await s.call("fin", "GET", "/dashboard/owner")).data;
    expect(o.receivables.collections).toMatchObject({ rate_pct: 23.1, days_to_pay: 9, open: 1 });
    expect(o.stores[0].days_to_pay).toBe(10); // over 180 days the June signing fee (10 days) counts too
    const log = (await s.call("tony", "GET", "/audit", undefined, NOW, { entity_type: "collection" })).data.items.find((a: any) => a.action === "collection:payment");
    expect(log.details).toMatchObject({ amount: 60_000, mode: "banktransfer", reference: "UTR123", payment_id: "PAY-1" });
  });

  it("closes an item paid in Books without FranchiseOS seeing the payment", async () => {
    const s = await setup();
    await s.list();
    s.invoices.get("INV-2")!.balance = 0;
    s.invoices.get("INV-2")!.paid = "2026-10-09";
    // The nightly sync marks the instalment paid; the next list closes the item.
    await s.store.update("fee_instalments", String(s.instalment.ROWID), { status: "PAID", invoice_balance: 0, paid_on: "2026-10-09" });
    const d = await s.list("PAID");
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ kind: "INSTALMENT", status: "PAID", paid_on: "2026-10-09", days_to_pay: 34 });
  });
});

describe("collections: settings and scoring", () => {
  it("keeps a sane ladder and lets the tenant change it", async () => {
    expect(normaliseLadder([{ days: 7, roles: ["FINANCE_MANAGER"] }, { days: -3, franchisee: true }, { days: 7, franchisee: true }, { days: 2, roles: ["NOBODY"] }, { days: 900, franchisee: true, flag: true }]))
      .toEqual([{ days: -3, franchisee: true, roles: [], flag: false }, { days: 7, franchisee: false, roles: ["FINANCE_MANAGER"], flag: false }, { days: 365, franchisee: true, roles: [], flag: true }]);
    expect(stepDue(DEFAULT_LADDER, "2026-10-15", "2026-10-11")).toBe(-1);
    expect(stepDue(DEFAULT_LADDER, "2026-10-15", "2026-10-12")).toBe(0);
    expect(stepDue(DEFAULT_LADDER, "2026-10-15", "2026-10-15")).toBe(1);
    expect(stepDue(DEFAULT_LADDER, "2026-10-15", "2026-11-20")).toBe(4);
    const s = await setup();
    expect((await s.call("tony", "GET", "/settings/collections")).data).toMatchObject({ ladder: DEFAULT_LADDER, roles: expect.arrayContaining(["FINANCE_MANAGER"]) });
    expect((await s.call("tony", "PUT", "/settings/collections", { ladder: [{ days: 1, franchisee: false, roles: [] }] })).error?.fields).toEqual({ ladder: "nobody to tell" });
    const r = (await s.call("tony", "PUT", "/settings/collections", { ladder: [{ days: 0, franchisee: true, roles: [] }, { days: 10, franchisee: true, roles: ["FINANCE_MANAGER"], flag: true }] })).data;
    expect(r.ladder).toEqual([{ days: 0, franchisee: true, roles: [], flag: false }, { days: 10, franchisee: true, roles: ["FINANCE_MANAGER"], flag: true }]);
    // The new ladder is what the chase follows: the instalment (22 days late) lands on the 10-day step and is flagged.
    await s.remind("2026-10-12T03:00:00Z");
    expect(await s.inbox("fin")).toEqual(["PROJ-1: ₹2,00,000 for at fit-out is 22 days late, escalated"]);
    expect(await s.inbox("fm")).toEqual([]);
  });

  it("scores slow payers and escalations", () => {
    expect(paymentsScore({ owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: 30_000, days_to_pay: 12 })).toBe(100);
    expect(paymentsScore({ owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: 30_000, days_to_pay: 41 })).toBe(90);
    expect(paymentsScore({ owed: 50_000, overdue: 20_000, oldest_days: 12, monthly_royalty: 30_000, escalated: true })).toBe(25);
    expect(paymentsScore({ owed: 50_000, overdue: 40_000, oldest_days: 95, monthly_royalty: 30_000, escalated: true })).toBe(0);
    const r = scoreHealth({ sales: { vs_plan_pct: 5, months: 3, months_under: 0 }, payments: { owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: 30_000, days_to_pay: 41 }, compliance: null, customer: null, reporting: null });
    expect(r.reasons.find((x) => x.part === "payments")?.text).toBe("Nothing owed, pays in 41 days on average");
  });

  it("measures billing and collection over a window from the three sources", () => {
    const agreements = [{ ROWID: "1", fee_status: "PAID", signed_at: "2026-09-01T00:00:00Z", fee_total: 100_000, fee_balance: 0, fee_paid_on: "2026-09-21", zoho_books_invoice_id: "A" }];
    const instalments = [
      { ROWID: "2", status: "PAID", invoiced_on: "2026-09-10", invoice_total: 50_000, invoice_balance: 0, paid_on: "2026-09-15", zoho_books_invoice_id: "B" },
      { ROWID: "3", status: "INVOICED", invoiced_on: "2026-05-10", invoice_total: 70_000, invoice_balance: 70_000, zoho_books_invoice_id: "C" }, // outside the window
      { ROWID: "4", status: "PAID", invoiced_on: "2026-09-01", invoice_total: 100_000, invoice_balance: 0, paid_on: "2026-09-21", zoho_books_invoice_id: "A" }, // the agreement's own invoice
    ];
    const reports = [{ ROWID: "5", status: "INVOICED", reviewed_at: "2026-10-01T00:00:00Z", invoice_total: 60_000, invoice_balance: 40_000, zoho_books_invoice_id: "D" }];
    expect(paymentBehaviour(agreements, instalments, reports, "2026-10-11")).toEqual({ billed: 210_000, collected: 170_000, rate_pct: 81, days_to_pay: 13, paid_count: 2 });
  });
});
