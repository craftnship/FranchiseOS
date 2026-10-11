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
  const south = await ins("territories", { territory_code: "TER-1", tenant_code_key: `${tid}:TER-1`, name: "Chennai", city: "Chennai", region: "South", status: "ALLOCATED" });
  const west = await ins("territories", { territory_code: "TER-2", tenant_code_key: `${tid}:TER-2`, name: "Pune", city: "Pune", region: "West", status: "ALLOCATED" });
  const store1 = async (n: number, ter: string, opened: string, target: string, signed: string, plan: number) => {
    const fr = await ins("franchisees", { franchise_code: `FR-${n}`, tenant_code_key: `${tid}:FR-${n}`, display_name: `Owner ${n}`, status: "ACTIVE" });
    const app = await ins("franchise_applications", { application_code: `APP-${n}`, tenant_code_key: `${tid}:APP-${n}`, franchisee_id: fr.ROWID, status: "ACTIVE", territory_id: ter });
    const site = await ins("sites", { site_code: `SITE-${n}`, tenant_code_key: `${tid}:SITE-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, territory_id: ter, city: n === 1 ? "Chennai" : "Pune", status: "READY_FOR_PROJECT" });
    await ins("feasibility_models", { application_id: app.ROWID, site_id: site.ROWID, monthly_revenue: plan, royalty_pct: 6, status: "CALCULATED" });
    await ins("agreements", { agreement_code: `AGR-${n}`, tenant_code_key: `${tid}:AGR-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", signed_at: `${signed} 10:00:00` });
    return ins("franchise_projects", { project_code: `PROJ-${n}`, tenant_code_key: `${tid}:PROJ-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: site.ROWID, status: "OPENED", actual_opening_date: opened, target_opening_date: target });
  };
  const p1 = await store1(1, String(south.ROWID), "2026-07-10", "2026-07-15", "2026-03-12", 1_000_000);
  const p2 = await store1(2, String(west.ROWID), "2026-08-20", "2026-08-01", "2026-04-22", 800_000);
  const rep = (p: { ROWID: unknown; franchisee_id?: unknown }, period: string, net: number, status: string, extra: Record<string, unknown> = {}) =>
    ins("sales_reports", { project_id: p.ROWID, franchisee_id: p.franchisee_id, period, period_key: `${tid}:${p.ROWID}:${period}`, status, gross_sales: net * 1.1, net_sales: net, ...extra });
  await rep(p1, "2026-07", 600_000, "PAID", { royalty_amount: 36_000, marketing_amount: 12_000, invoice_total: 48_000, invoice_balance: 0 });
  await rep(p1, "2026-08", 1_100_000, "INVOICED", { royalty_amount: 66_000, marketing_amount: 22_000, invoice_total: 88_000, invoice_balance: 88_000 });
  await rep(p1, "2026-09", 1_210_000, "SUBMITTED");
  await rep(p2, "2026-08", 400_000, "RETURNED");
  // Funnel: three applications with status moves logged.
  const move = async (appId: unknown, to: string, when: string) => ins("activity_logs", { entity_type: "application", entity_id: String(appId), action: "transition:x", metadata_json: JSON.stringify({ to }), created_at: when });
  for (const [n, status, path] of [[3, "REJECTED", ["SUBMITTED", "UNDER_REVIEW"]], [4, "QUALIFIED", ["SUBMITTED", "UNDER_REVIEW", "QUALIFIED"]], [5, "SUBMITTED", ["SUBMITTED"]]] as const) {
    const a = await ins("franchise_applications", { application_code: `APP-${n}`, tenant_code_key: `${tid}:APP-${n}`, franchisee_id: "1", status, territory_id: String(south.ROWID) });
    for (let i = 0; i < path.length; i++) await move(a.ROWID, path[i], `2026-09-0${1 + i * (n - 2)}T00:00:00.000Z`);
  }
  const call = async (path: string, query: Record<string, string> = {}, ext = "fin") => (await router.handle({ method: "GET", path: `/api/v1${path}`, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date("2026-10-11T06:00:00Z") })).body as { success: boolean; data?: any; error?: { code: string } };
  return { call };
}

describe("owner analytics", () => {
  it("rolls up sales and royalty by month and store, against plan", async () => {
    const s = await setup();
    const a = (await s.call("/analytics", { months: "3" })).data;
    expect([a.period_from, a.period_to]).toEqual(["2026-07", "2026-09"]);
    expect(a.sales.series.map((m: any) => [m.period, m.net_sales, m.royalty, m.collected, m.stores_reporting, m.stores_due])).toEqual([
      ["2026-07", 600_000, 48_000, 48_000, 1, 1], ["2026-08", 1_100_000, 88_000, 0, 1, 2], ["2026-09", 1_210_000, 0, 0, 1, 2],
    ]);
    expect(a.sales.totals).toMatchObject({ net_sales: 2_910_000, royalty: 136_000, collected: 48_000, unpaid: 88_000, stores: 2, avg_store_month: 970_000, reporting_pct: 60 });
    const [top, other] = a.sales.stores;
    expect(top).toMatchObject({ project_code: "PROJ-1", region: "South", city: "Chennai", months_due: 3, months_reported: 3, reporting_pct: 100, last_net_sales: 1_210_000, change_pct: 10, avg_net_sales: 970_000, plan_net_sales: 1_000_000, vs_plan_pct: -3 });
    // A returned report doesn't count as reported.
    expect(other).toMatchObject({ project_code: "PROJ-2", months_due: 2, months_reported: 0, net_sales: 0, avg_net_sales: null });
  });

  it("measures opening speed and funnel drop-off, and filters by region", async () => {
    const s = await setup();
    const a = (await s.call("/analytics")).data;
    expect(a.openings.items.map((o: any) => [o.project_code, o.days_to_open, o.days_late])).toEqual([["PROJ-2", 120, 19], ["PROJ-1", 120, -5]]);
    expect(a.openings).toMatchObject({ median_days_to_open: 120, on_time_pct: 50, avg_days_late: 7 });
    expect(a.regions).toEqual(["South", "West"]);
    const stage = (k: string) => a.pipeline.stages.find((x: any) => x.stage === k);
    expect(stage("SUBMITTED")).toMatchObject({ reached: 5, to_next_pct: 80, median_days: 1.5 });
    expect(stage("UNDER_REVIEW")).toMatchObject({ reached: 4, median_days: 2 });
    expect(stage("QUALIFIED")).toMatchObject({ reached: 3, current: 1 });
    expect(a.pipeline).toMatchObject({ applications: 5, signed: 2, signed_pct: 40 });
    const west = (await s.call("/analytics", { region: "West" })).data;
    expect(west.sales.stores.map((x: any) => x.project_code)).toEqual(["PROJ-2"]);
    expect(west.openings.items).toHaveLength(1);
    expect(west.pipeline.applications).toBe(1);
  });

  it("is for dashboard viewers only", async () => {
    const s = await setup();
    expect((await s.call("/analytics", {}, "nobody")).success).toBe(false);
    expect((await s.call("/analytics", { months: "5" })).error?.code).toBe("VALIDATION_FAILED");
  });
});
