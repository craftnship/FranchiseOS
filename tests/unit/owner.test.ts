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
  await ins("users", { email: "fin@x.test", status: "ACTIVE", role_id: t.roleIds.FINANCE_MANAGER, external_user_id: "fin" });
  await ins("users", { email: "ops@x.test", status: "ACTIVE", role_id: t.roleIds.OPERATIONS_MANAGER, external_user_id: "ops" });
  const ter = await ins("territories", { territory_code: "TER-1", tenant_code_key: `${tid}:TER-1`, name: "Chennai T Nagar", city: "Chennai", region: "South", status: "ALLOCATED" });
  const mk = async (n: number, status: string, extra: Record<string, unknown> = {}, plan = 1_000_000) => {
    const fr = await ins("franchisees", { franchise_code: `FR-${n}`, tenant_code_key: `${tid}:FR-${n}`, display_name: `Owner ${n}`, status: "ACTIVE" });
    const app = await ins("franchise_applications", { application_code: `APP-${n}`, tenant_code_key: `${tid}:APP-${n}`, franchisee_id: fr.ROWID, status: "ACTIVE", territory_id: n === 1 ? ter.ROWID : null, preferred_city: `City ${n}` });
    const site = await ins("sites", { site_code: `SITE-${n}`, tenant_code_key: `${tid}:SITE-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, territory_id: n === 1 ? ter.ROWID : null, city: `City ${n}`, area_sqft: 2000, status: "READY_FOR_PROJECT" });
    await ins("feasibility_models", { application_id: app.ROWID, site_id: site.ROWID, monthly_revenue: plan, royalty_pct: 4, marketing_fund_pct: 1, status: "CALCULATED" });
    // Store 2's signing invoice never got its Books id, so its instalment can only be matched to the agreement.
    const agr = await ins("agreements", { agreement_code: `AGR-${n}`, tenant_code_key: `${tid}:AGR-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", fee_status: n === 2 ? "OVERDUE" : "PAID", fee_total: 500_000, fee_balance: n === 2 ? 500_000 : 0, fee_due_date: "2026-08-01", zoho_books_invoice_id: n === 2 ? null : `INV-${n}` });
    if (n === 2) await ins("fee_instalments", { agreement_id: agr.ROWID, kind: "FEE", label: "Franchise fee", amount: 500_000, raise_on: "SIGNING", status: "INVOICED", invoice_total: 500_000, invoice_balance: 500_000, invoice_due_date: "2026-08-01" });
    return ins("franchise_projects", { project_code: `PROJ-${n}`, tenant_code_key: `${tid}:PROJ-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: site.ROWID, status, ...extra });
  };
  const p1 = await mk(1, "OPENED", { actual_opening_date: "2026-06-05" });
  const p2 = await mk(2, "OPENED", { actual_opening_date: "2026-07-10" }, 800_000);
  const p3 = await mk(3, "IN_PROGRESS", { target_opening_date: "2026-11-20", forecast_opening_date: "2026-12-10", forecast_slip_days: 20, risk_level: "HIGH", readiness_rag: "RED" });
  const rep = (p: { ROWID: unknown }, period: string, net: number, status: string, extra: Record<string, unknown> = {}) =>
    ins("sales_reports", { project_id: p.ROWID, period, period_key: `${tid}:${p.ROWID}:${period}`, status, net_sales: net, ...extra });
  await rep(p1, "2026-08", 900_000, "PAID", { royalty_amount: 36_000, marketing_amount: 9_000, invoice_total: 45_000, invoice_balance: 0 });
  await rep(p1, "2026-09", 1_000_000, "SUBMITTED");
  await rep(p2, "2026-08", 500_000, "INVOICED", { royalty_amount: 20_000, marketing_amount: 5_000, invoice_total: 25_000, invoice_balance: 25_000, invoice_due_date: "2026-09-15" });
  await rep(p2, "2026-09", 600_000, "RETURNED", { review_note: "Attach the POS export" });
  await ins("approval_instances", { entity_type: "application", entity_id: "999", status: "PENDING", step_due_at: "2026-10-10T00:00:00Z" });
  const audit = await ins("audits", { audit_code: "AUD-1", tenant_code_key: `${tid}:AUD-1`, project_id: p2.ROWID, status: "COMPLETED", completed_at: "2026-09-20 10:00:00", score: 62, rating: "RED" });
  await ins("audits", { audit_code: "AUD-2", tenant_code_key: `${tid}:AUD-2`, project_id: p1.ROWID, status: "COMPLETED", completed_at: "2026-09-01 10:00:00", score: 91, rating: "GREEN" });
  await ins("corrective_actions", { audit_id: audit.ROWID, project_id: p2.ROWID, action_key: "a1", item_code: "FIRE", description: "Fire exit blocked: boxes in the corridor", severity: "CRITICAL", due_date: "2026-10-01", status: "OPEN" });
  await ins("licences", { project_id: p1.ROWID, licence_code: "SIGN", name: "Signage licence", status: "ISSUED", expires_on: "2026-10-30", mandatory: true });
  await ins("purchase_orders", { project_id: p3.ROWID, vendor_id: "1", po_number: "PO-7", status: "CONFIRMED", needed_by: "2026-10-20", expected_delivery: "2026-11-05" });
  await ins("licences", { project_id: p3.ROWID, licence_code: "TRADE", name: "Trade licence", status: "APPLIED", mandatory: true, notes: "Waiting on fire NOC" });
  const call = async (path: string, query: Record<string, string> = {}, ext = "fin") => (await router.handle({ method: "GET", path: `/api/v1${path}`, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date("2026-10-11T06:00:00Z") })).body as { success: boolean; data?: any; error?: { code: string } };
  return { call };
}

describe("owner dashboard", () => {
  it("compares revenue with the period before and ages what is owed", async () => {
    const s = await setup();
    const o = (await s.call("/dashboard/owner")).data;
    expect(o.period).toMatchObject({ from: "2026-09", to: "2026-09", label: "Sep 2026", previous_label: "Aug 2026" });
    // September: one report in (one returned), not yet invoiced; August: both in.
    expect(o.revenue).toMatchObject({ net_sales: 1_000_000, reports: 1, due: 2, reporting_pct: 50, stores_trading: 2 });
    expect(o.revenue.previous).toMatchObject({ net_sales: 1_400_000, royalty: 70_000, collected: 45_000 });
    expect(o.revenue.net_sales_change_pct).toBe(-28.6);
    // September's report isn't approved yet: nothing billed, but its royalty and fund are due at the store's rates.
    expect(o.revenue).toMatchObject({ royalty: 0, awaiting_review: 1, royalty_pending: 50_000 });
    const q = (await s.call("/dashboard/owner", { months: "3" })).data;
    expect(q.revenue).toMatchObject({ net_sales: 2_400_000, royalty: 70_000, collection_pct: 64.3 });
    expect(o.receivables).toMatchObject({ total: 525_000, overdue: 525_000, fees: 500_000, royalty: 25_000 });
    expect(o.receivables.ageing.find((b: any) => b.key === "d1_30").amount).toBe(25_000);
    expect(o.receivables.ageing.find((b: any) => b.key === "d61_90").amount).toBe(500_000);
  });

  it("shows money only to finance.view", async () => {
    const s = await setup();
    const o = (await s.call("/dashboard/owner", {}, "ops")).data;
    expect(o.finance).toBe(false);
    expect(o.receivables).toBeNull();
    expect(o.revenue).toMatchObject({ net_sales: 1_000_000, stores_trading: 2 });
    expect(o.revenue.royalty).toBeUndefined();
    expect(o.stores.every((x: any) => x.unpaid === null)).toBe(true);
    expect(o.attention.items.some((i: any) => i.kind === "Fee" || i.kind === "Royalty")).toBe(false);
    expect((await s.call("/dashboard/network", {}, "ops")).data).toMatchObject({ fees_collected: null, fees_outstanding: null, fees_overdue: null });
    expect((await s.call("/fees", {}, "ops")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("/dashboard/owner")).data.finance).toBe(true);
  });

  it("ranks stores and rolls up compliance", async () => {
    const s = await setup();
    const o = (await s.call("/dashboard/owner")).data;
    expect(o.stores.map((x: any) => [x.name, x.avg_net_sales, x.vs_plan_pct, x.audit_rating, x.open_actions, x.unpaid])).toEqual([
      ["Chennai T Nagar", 950_000, -5, "GREEN", 0, 0], ["City 2", 500_000, -37.5, "RED", 1, 525_000],
    ]);
    expect(o.stores[0].sales_per_sqft).toBe(475);
    expect(o.compliance.audits).toMatchObject({ green: 1, red: 1, not_audited: 0, average_score: 76.5 });
    expect(o.compliance.actions).toMatchObject({ open: 1, overdue: 1, critical: 1 });
    expect(o.compliance.licences).toMatchObject({ expired: 0, expiring_30: 1 });
  });

  it("lists what needs the brand team, most urgent first", async () => {
    const s = await setup();
    const { items, counts } = (await s.call("/dashboard/owner")).data.attention;
    const kinds = items.map((i: any) => `${i.tone} ${i.kind}: ${i.title}`);
    expect(kinds).toEqual(expect.arrayContaining([
      "bad Approval: Application waiting for approval",
      "info Sales report: Chennai T Nagar Sep 2026 sales to review",
      "warn Sales report: City 2 Sep 2026 report returned",
      "bad Royalty: City 2 Aug 2026 royalty overdue",
      "bad Fee: City 2 signing fee overdue",
      "bad Audit action: City 2: Fire exit blocked",
      "warn Licence: Chennai T Nagar Signage licence expires soon",
      "warn Purchase order: City 3 PO-7 running late",
    ]));
    expect(items[0].tone).toBe("bad");
    expect(counts.bad).toBe(4);
  });

  it("explains openings at risk and counts the ones forecast to slip", async () => {
    const s = await setup();
    const r = (await s.call("/dashboard/risk")).data;
    expect(r.at_risk.items[0]).toMatchObject({ project_code: "PROJ-3", name: "City 3", slip_days: 20, forecast_opening_date: "2026-12-10" });
    expect(r.at_risk.items[0].reasons).toEqual(["PO-7 delivery late", "Trade licence pending (Waiting on fire NOC)"]);
    const n = (await s.call("/dashboard/network")).data;
    expect([n.delayed_openings.value, n.slipping_openings.value]).toEqual([0, 1]);
    expect((await s.call("/projects", { slipping: "true" })).data.map((p: any) => p.project_code)).toEqual(["PROJ-3"]);
    expect((await s.call("/dashboard/owner", {}, "nobody")).success).toBe(false);
  });
});
