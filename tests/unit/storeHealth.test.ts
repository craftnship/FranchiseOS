import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { complianceScore, DEFAULT_HEALTH, paymentsScore, reportingScore, salesScore, scoreHealth } from "../../functions/scoring/health";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = "2026-10-11T06:00:00Z";

describe("health score parts", () => {
  it("scores sales against plan, with a penalty for repeated months under", () => {
    expect(salesScore({ vs_plan_pct: 10, months: 3, months_under: 0 })).toBe(100);
    expect(salesScore({ vs_plan_pct: 0, months: 3, months_under: 0 })).toBe(85);
    expect(salesScore({ vs_plan_pct: -40, months: 3, months_under: 3 })).toBe(0);
    expect(salesScore({ vs_plan_pct: -25, months: 3, months_under: 1 })).toBe(30);
    expect(salesScore({ vs_plan_pct: -25, months: 3, months_under: 3 })).toBe(20);
  });

  it("scores payments by the oldest overdue item and its size against a month's royalty", () => {
    expect(paymentsScore({ owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: 30_000 })).toBe(100);
    expect(paymentsScore({ owed: 50_000, overdue: 0, oldest_days: 0, monthly_royalty: 30_000 })).toBe(90);
    expect(paymentsScore({ owed: 50_000, overdue: 20_000, oldest_days: 12, monthly_royalty: 30_000 })).toBe(70);
    expect(paymentsScore({ owed: 50_000, overdue: 40_000, oldest_days: 45, monthly_royalty: 30_000 })).toBe(40);
    expect(paymentsScore({ owed: 500_000, overdue: 500_000, oldest_days: 71, monthly_royalty: 30_000 })).toBe(10);
    expect(paymentsScore({ owed: 500_000, overdue: 500_000, oldest_days: 120, monthly_royalty: null })).toBe(5);
  });

  it("scores compliance from the audit, and leaves an unaudited store out until its audit is overdue", () => {
    expect(complianceScore({ audit_score: null, critical_open: 0, overdue_actions: 0, expired_licences: 0, audit_overdue: false })).toBeNull();
    expect(complianceScore({ audit_score: null, critical_open: 0, overdue_actions: 0, expired_licences: 0, audit_overdue: true })).toBe(30);
    expect(complianceScore({ audit_score: 62, critical_open: 1, overdue_actions: 1, expired_licences: 0, audit_overdue: false })).toBe(42);
    expect(complianceScore({ audit_score: 90, critical_open: 5, overdue_actions: 9, expired_licences: 3, audit_overdue: true })).toBe(0);
    expect(reportingScore({ due: 6, on_time: 5, late: 1 })).toBe(92);
    expect(reportingScore({ due: 0, on_time: 0, late: 0 })).toBeNull();
  });

  it("weights the parts that have data, and caps a store with a very weak part at Watch", () => {
    const r = scoreHealth({ sales: { vs_plan_pct: 0, months: 3, months_under: 0 }, payments: { owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: null }, compliance: null, reporting: null, customer: null });
    expect(r.score).toBe(Math.round((85 * 35 + 100 * 25) / 60));
    expect(r.band).toBe("HEALTHY");
    expect(r.parts.filter((p) => p.score === null).map((p) => p.part)).toEqual(["compliance", "reporting", "customer"]);
    expect(r.reasons.map((x) => x.text)).toEqual(["Sales 0% ahead of plan", "Nothing owed"]);
    const capped = scoreHealth({ sales: null, payments: { owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: null }, compliance: null, reporting: { due: 1, on_time: 0, late: 0 }, customer: null });
    expect(capped).toMatchObject({ score: 71, band: "WATCH", capped: true });
    expect(scoreHealth({ sales: null, payments: null, compliance: null, reporting: null, customer: null })).toMatchObject({ score: null, band: null, reasons: [] });
    // A tenant can move the limits.
    const strict = scoreHealth({ sales: { vs_plan_pct: 0, months: 3, months_under: 0 }, payments: null, compliance: null, reporting: null, customer: null }, { ...DEFAULT_HEALTH, thresholds: { healthy_from: 90, watch_from: 50, part_floor: 25 } });
    expect(strict).toMatchObject({ score: 85, band: "WATCH" });
  });
});

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  const user = (role: string, ext: string, extra: Record<string, unknown> = {}) => ins("users", { email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, ...extra });
  await user("SUPER_ADMIN", "boss");
  await user("FRANCHISE_MANAGER", "fm");
  await user("OPERATIONS_MANAGER", "ops");
  await user("FINANCE_MANAGER", "fin");
  await user("REGIONAL_MANAGER", "rm", { region: "South" });
  await user("REGIONAL_MANAGER", "rmw", { region: "West" });
  const south = await ins("territories", { territory_code: "TER-S", tenant_code_key: `${tid}:TER-S`, name: "Chennai", city: "Chennai", region: "South", status: "ALLOCATED" });
  const west = await ins("territories", { territory_code: "TER-W", tenant_code_key: `${tid}:TER-W`, name: "Pune", city: "Pune", region: "West", status: "ALLOCATED" });
  const owners: Record<number, string> = {};
  const mk = async (n: number, ter: { ROWID: unknown }, status: string, opened: string | null, plan: number) => {
    const fr = await ins("franchisees", { franchise_code: `FR-${n}`, tenant_code_key: `${tid}:FR-${n}`, display_name: `Owner ${n}`, status: "ACTIVE" });
    owners[n] = String(fr.ROWID);
    await user("FRANCHISEE", `owner${n}`, { franchisee_id: fr.ROWID });
    const app = await ins("franchise_applications", { application_code: `APP-${n}`, tenant_code_key: `${tid}:APP-${n}`, franchisee_id: fr.ROWID, status: "ACTIVE", territory_id: ter.ROWID });
    const site = await ins("sites", { site_code: `SITE-${n}`, tenant_code_key: `${tid}:SITE-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, territory_id: ter.ROWID, status: "READY_FOR_PROJECT" });
    await ins("feasibility_models", { application_id: app.ROWID, site_id: site.ROWID, monthly_revenue: plan, royalty_pct: 4, marketing_fund_pct: 1, status: "CALCULATED" });
    const agr = await ins("agreements", { agreement_code: `AGR-${n}`, tenant_code_key: `${tid}:AGR-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", fee_status: n === 2 ? "OVERDUE" : "PAID", fee_total: 500_000, fee_balance: n === 2 ? 500_000 : 0, fee_due_date: "2026-08-01", zoho_books_invoice_id: `INV-${n}` });
    const p = await ins("franchise_projects", { project_code: `PROJ-${n}`, tenant_code_key: `${tid}:PROJ-${n}`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: site.ROWID, status, actual_opening_date: opened });
    return { p, agr };
  };
  const rep = (p: { ROWID: unknown }, period: string, net: number, extra: Record<string, unknown> = {}) =>
    ins("sales_reports", { project_id: p.ROWID, period, period_key: `${tid}:${p.ROWID}:${period}`, status: "PAID", net_sales: net, invoice_balance: 0, ...extra });
  // Chennai: ahead of plan, paid up, a good audit, every report in on time.
  const { p: p1 } = await mk(1, south, "OPENED", "2026-06-05", 1_000_000);
  for (const [per, net] of [["2026-06", 800_000], ["2026-07", 1_100_000], ["2026-08", 1_000_000], ["2026-09", 1_050_000]] as const) await rep(p1, per, net);
  await ins("audits", { audit_code: "AUD-1", tenant_code_key: `${tid}:AUD-1`, project_id: p1.ROWID, status: "COMPLETED", completed_at: "2026-09-01 10:00:00", score: 91, rating: "GREEN" });
  // Madurai: a quarter under plan for three months, the signing fee 71 days overdue, a red audit with a critical action overdue, one late report.
  const { p: p2, agr: agr2 } = await mk(2, south, "OPENED", "2026-03-01", 800_000);
  for (const [per, net, extra] of [["2026-04", 700_000, {}], ["2026-05", 700_000, {}], ["2026-06", 650_000, { submitted_at: "2026-07-20 09:00:00" }], ["2026-07", 600_000, {}], ["2026-08", 560_000, {}], ["2026-09", 640_000, {}]] as const) await rep(p2, per, net, extra);
  const audit = await ins("audits", { audit_code: "AUD-2", tenant_code_key: `${tid}:AUD-2`, project_id: p2.ROWID, status: "COMPLETED", completed_at: "2026-09-20 10:00:00", score: 62, rating: "RED" });
  await ins("corrective_actions", { audit_id: audit.ROWID, project_id: p2.ROWID, action_key: "a1", item_code: "FIRE", description: "Fire exit blocked", severity: "CRITICAL", due_date: "2026-10-01", status: "OPEN" });
  // Hyderabad: opened three weeks ago, no full month and no audit due yet, September's report not in.
  const { p: p3 } = await mk(3, south, "OPENED", "2026-09-20", 900_000);
  // Pune: on plan, paid up, audited, all reports in.
  const { p: p4 } = await mk(4, west, "OPENED", "2026-01-01", 500_000);
  for (const per of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) await rep(p4, per, 500_000);
  await ins("audits", { audit_code: "AUD-4", tenant_code_key: `${tid}:AUD-4`, project_id: p4.ROWID, status: "COMPLETED", completed_at: "2026-08-01 10:00:00", score: 80, rating: "AMBER" });
  // Mysuru: still opening.
  await mk(5, south, "IN_PROGRESS", null, 700_000);
  const call = async (ext: string, method: string, path: string, query: Record<string, string> = {}, body?: unknown, now = NOW) =>
    (await router.handle({ method, path: `/api/v1${path}`, query, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now) })).body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  const snapshots = (p: { ROWID: unknown }) => store.findMany("store_health", { tenant_id: tid, project_id: String(p.ROWID) });
  return { store, tid, call, inbox, snapshots, p1, p2, p3, p4, agr2, owners };
}

describe("franchisee health", () => {
  it("scores every trading store and shows the network with its weakest stores first", async () => {
    const s = await setup();
    expect((await s.call("boss", "POST", "/admin/health/recalculate")).data).toEqual({ stores: 4, scored: 4, changed: 4, alerted: 1 });
    const h = (await s.call("fin", "GET", "/dashboard/health")).data;
    expect(h).toMatchObject({ finance: true, region: null, bands: { healthy: 2, watch: 1, at_risk: 1, unscored: 0 }, as_of: "2026-10-11", thresholds: { healthy_from: 70, watch_from: 50, part_floor: 25 } });
    expect(h.stores.map((x: any) => [x.project_code, x.score, x.band])).toEqual([["PROJ-2", 30, "AT_RISK"], ["PROJ-3", 71, "WATCH"], ["PROJ-4", 90, "HEALTHY"], ["PROJ-1", 95, "HEALTHY"]]);
    expect(h.lowest[0]).toMatchObject({ name: "Chennai", franchisee: "Owner 2", region: "South", capped: false });
    expect(h.lowest[0].reasons.map((r: any) => r.text)).toEqual(["₹5 L overdue, oldest 71 days", "Sales 25% under plan for 3 of 3 months"]);
    expect(h.stores[1]).toMatchObject({ project_code: "PROJ-3", capped: true });
    // Without finance.view the reasons say what is wrong, not how much.
    const ops = (await s.call("ops", "GET", "/dashboard/health")).data;
    expect(ops.finance).toBe(false);
    expect(ops.lowest[0].reasons[0].text).toBe("Payments overdue, oldest 71 days");
    // The region filter, and the regional manager's lock.
    expect((await s.call("fin", "GET", "/dashboard/health", { region: "West" })).data.stores.map((x: any) => x.project_code)).toEqual(["PROJ-4"]);
    const rm = (await s.call("rm", "GET", "/dashboard/health", { region: "West" })).data;
    expect(rm).toMatchObject({ region: "South", region_locked: true, bands: { healthy: 1, watch: 1, at_risk: 1 } });
    // The league table and the map carry the band too.
    expect((await s.call("fin", "GET", "/dashboard/owner")).data.stores.find((x: any) => x.project_code === "PROJ-2")).toMatchObject({ health_score: 30, health_band: "AT_RISK" });
    expect((await s.call("fin", "GET", "/dashboard/map")).data.points.find((x: any) => x.id === String(s.p2.ROWID)).health).toBe("AT_RISK");
  });

  it("alerts the brand team and the store's regional manager once per change, and keeps one row per day", async () => {
    const s = await setup();
    await s.call("boss", "POST", "/admin/health/recalculate");
    for (const who of ["fm", "ops", "rm"]) expect(await s.inbox(who)).toContain("PROJ-2 is at risk (health 30)");
    expect(await s.inbox("rmw")).not.toContain("PROJ-2 is at risk (health 30)");
    expect(await s.inbox("fin")).not.toContain("PROJ-2 is at risk (health 30)");
    // The same day again: nothing changes, nothing repeats.
    expect((await s.call("boss", "POST", "/admin/health/recalculate")).data).toMatchObject({ changed: 0, alerted: 0 });
    expect(await s.snapshots(s.p2)).toHaveLength(1);
    expect((await s.inbox("fm")).filter((x) => x.startsWith("PROJ-2 is at risk"))).toHaveLength(1);
    // Madurai pays its fee and has a strong quarter: healthy again, said once.
    await s.store.update("agreements", String(s.agr2.ROWID), { fee_status: "PAID", fee_balance: 0 });
    for (const r of await s.store.findMany("sales_reports", { tenant_id: s.tid, project_id: String(s.p2.ROWID) })) if (["2026-07", "2026-08", "2026-09"].includes(String(r.period))) await s.store.update("sales_reports", String(r.ROWID), { net_sales: 900_000 });
    expect((await s.call("boss", "POST", "/admin/health/recalculate", {}, undefined, "2026-10-12T06:00:00Z")).data).toMatchObject({ changed: 1, alerted: 1 });
    expect(await s.inbox("fm")).toContain("PROJ-2 is healthy again (health 86)");
    expect(await s.snapshots(s.p2)).toHaveLength(2);
    const log = await s.store.findMany("activity_logs", { tenant_id: s.tid, action: "health:band_changed" });
    expect(log.filter((l) => String(l.entity_id) === String(s.p2.ROWID))).toHaveLength(2);
  });

  it("shows a store its own score and trend, and nobody else's", async () => {
    const s = await setup();
    await s.call("boss", "POST", "/admin/health/recalculate");
    const mine = (await s.call("owner2", "GET", `/projects/${s.p2.ROWID}/health`)).data;
    expect(mine).toMatchObject({ project_code: "PROJ-2", score: 30, band: "AT_RISK", trading: true, updated_on: "2026-10-11" });
    expect(mine.parts.map((p: any) => [p.part, p.score])).toEqual([["sales", 20], ["payments", 10], ["compliance", 42], ["reporting", 92], ["customer", null]]);
    expect(mine.parts[2].detail).toBe("Audit 62%, 1 critical action open, 1 action overdue");
    expect(mine.history).toEqual([{ as_of: "2026-10-11", score: 30, band: "AT_RISK" }]);
    expect(mine.reasons[0].text).toBe("Payments overdue, oldest 71 days");
    expect((await s.call("fin", "GET", `/projects/${s.p2.ROWID}/health`)).data.reasons[0].text).toBe("₹5 L overdue, oldest 71 days");
    expect((await s.call("owner1", "GET", `/projects/${s.p2.ROWID}/health`)).error?.code).toBe("NOT_FOUND");
    const young = (await s.call("fm", "GET", `/projects/${s.p3.ROWID}/health`)).data;
    expect(young.parts[0]).toMatchObject({ part: "sales", score: null, detail: "Too new to measure against plan" });
    expect(young.parts[3]).toMatchObject({ part: "reporting", score: 0, detail: "0 of 1 sales reports on time, 1 missing" });
    expect((await s.call("ops", "POST", "/admin/health/recalculate")).error?.code).toBe("ACCESS_DENIED");
  });

  it("lets an admin change the weights and limits, and rescoring follows", async () => {
    const s = await setup();
    const before = (await s.call("boss", "GET", "/settings/health")).data;
    expect(before.weights).toEqual({ sales: 35, payments: 25, compliance: 20, reporting: 10, customer: 10 });
    expect(before.parts.map((p: any) => p.label)).toEqual(["Sales", "Payments", "Compliance", "Reporting", "Customer"]);
    const put = (body: unknown) => s.call("boss", "PUT", "/settings/health", {}, body);
    expect((await put({ weights: before.weights, thresholds: { healthy_from: 60, watch_from: 70, part_floor: 25 } })).error?.fields).toEqual({ thresholds: "watch_from must be below healthy_from" });
    expect((await put({ weights: { sales: 0, payments: 0, compliance: 0, reporting: 0, customer: 0 }, thresholds: before.thresholds })).error?.fields).toEqual({ weights: "all zero" });
    const after = (await put({ weights: { sales: 0, payments: 0, compliance: 100, reporting: 0, customer: 0 }, thresholds: { healthy_from: 80, watch_from: 50, part_floor: 0 } })).data;
    expect(after.thresholds).toEqual({ healthy_from: 80, watch_from: 50, part_floor: 0 });
    await s.call("boss", "POST", "/admin/health/recalculate");
    const h = (await s.call("boss", "GET", "/dashboard/health")).data;
    // Only the audit counts now: Hyderabad has none, so it is unscored; Chennai 91 is healthy, Pune 80 just makes it.
    expect(h.stores.map((x: any) => [x.project_code, x.score, x.band])).toEqual([["PROJ-2", 42, "AT_RISK"], ["PROJ-4", 80, "HEALTHY"], ["PROJ-1", 91, "HEALTHY"], ["PROJ-3", null, null]]);
    expect(h.bands).toEqual({ healthy: 2, watch: 0, at_risk: 1, unscored: 1 });
    expect((await s.call("fm", "GET", "/settings/health")).error?.code).toBe("ACCESS_DENIED");
  });
});
