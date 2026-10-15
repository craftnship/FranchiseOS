import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = new Date("2026-10-10T06:00:00Z");

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Yaazh Fashions", email: "yaazh@x.test", status: "ACTIVE" });
  const other = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Someone Else", status: "PROSPECT" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, name: ext, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("FRANCHISE_MANAGER", "mgr");
  await user("FINANCE_MANAGER", "fin");
  await user("LEGAL_MANAGER", "legal");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "stranger", String(other.ROWID));
  const fid = String(fr.ROWID);
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fid, application_type: "UNIT", status: "ONBOARDING" });
  const app2 = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000002", tenant_code_key: `${tid}:APP-000002`, franchisee_id: fid, application_type: "UNIT", status: "UNDER_REVIEW" });
  const site = await store.insert("sites", { tenant_id: tid, site_code: "SITE-000001", tenant_code_key: `${tid}:SITE-000001`, application_id: app.ROWID, franchisee_id: fid, territory_id: "1", city: "Tiruppur", status: "READY_FOR_PROJECT" });
  const agreement = await store.insert("agreements", { tenant_id: tid, agreement_code: "AGR-000001", tenant_code_key: `${tid}:AGR-000001`, application_id: app.ROWID, franchisee_id: fid, template_id: "1", status: "SIGNED", signed_at: "2026-06-01 10:00:00", effective_date: "2026-06-01", expiry_date: "2031-05-31", fee_status: "PAID", fee_total: 590000, fee_balance: 0 });
  const open = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: app.ROWID, franchisee_id: fid, site_id: site.ROWID, status: "OPENED", target_opening_date: "2026-06-28", actual_opening_date: "2026-07-01", health_score: 72, health_band: "WATCH", pos_status: "CONNECTED", pos_last_day: "2026-10-09", royalty_pct: 6, marketing_fund_pct: 2 });
  const opening = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000002", tenant_code_key: `${tid}:PROJ-000002`, application_id: app2.ROWID, franchisee_id: fid, status: "IN_PROGRESS", target_opening_date: "2027-02-01" });
  const report = (period: string, extra: Record<string, unknown>) => store.insert("sales_reports", { tenant_id: tid, project_id: open.ROWID, franchisee_id: fid, period, period_key: `${tid}:${open.ROWID}:${period}`, source: "POS", basis: "POS", ...extra });
  await report("2026-07", { status: "PAID", net_sales: 520000, pos_net_sales: 520000, reported_net_sales: 515000, variance_pct: -1, royalty_pct: 6, marketing_fund_pct: 2, royalty_amount: 31200, marketing_amount: 10400, invoice_number: "INV-000010", invoice_total: 49088, invoice_balance: 0 });
  await report("2026-08", { status: "INVOICED", net_sales: 610000, pos_net_sales: 610000, reported_net_sales: 607000, variance_pct: -0.5, royalty_pct: 6, marketing_fund_pct: 2, royalty_amount: 36600, marketing_amount: 12200, invoice_number: "INV-000011", invoice_total: 57584, invoice_balance: 57584, invoice_due_date: "2026-09-22" });
  await report("2026-09", { status: "SUBMITTED", net_sales: 650000, pos_net_sales: 650000, reported_net_sales: 590000, variance_pct: -9.2 });
  for (const d of ["2026-10-01", "2026-10-02"]) await store.insert("pos_sales", { tenant_id: tid, project_id: open.ROWID, franchisee_id: fid, day: d, day_key: `${tid}:${open.ROWID}:${d}`, gross_sales: 70000, discounts: 5000, returns: 1000, net_sales: 64000, tax: 3200, transactions: 40, source: "UPLOAD" });
  const audit = await store.insert("audits", { tenant_id: tid, audit_code: "AUD-000001", tenant_code_key: `${tid}:AUD-000001`, project_id: open.ROWID, franchisee_id: fid, site_id: site.ROWID, audit_type: "OPENING", status: "COMPLETED", completed_at: "2026-07-20 12:00:00", score: 85.1, rating: "GREEN", critical_fails: 0 });
  await store.insert("corrective_actions", { tenant_id: tid, audit_id: audit.ROWID, project_id: open.ROWID, franchisee_id: fid, action_key: `${tid}:${audit.ROWID}:SIZE`, item_code: "SIZE", description: "Size curve", severity: "MAJOR", due_date: "2026-10-01", status: "OPEN" });
  await store.insert("licences", { tenant_id: tid, project_id: open.ROWID, franchisee_id: fid, licence_code: "TRADE", name: "Trade licence", status: "ISSUED", expires_on: "2026-11-15", licence_key: `${tid}:${open.ROWID}:TRADE` });
  await store.insert("collections", { tenant_id: tid, collection_key: `${tid}:ROYALTY:1`, kind: "ROYALTY", source_id: "1", project_id: open.ROWID, franchisee_id: fid, invoice_number: "INV-000011", period: "2026-08", amount: 57584, total: 57584, due_date: "2026-09-22", status: "OPEN", step: 1, reminders_sent: 1, escalated: false, promise_broken: false });
  await store.insert("fee_instalments", { tenant_id: tid, project_id: open.ROWID, agreement_id: agreement.ROWID, franchisee_id: fid, seq: 1, instalment_key: `${tid}:${agreement.ROWID}:1`, kind: "FEE", label: "On signing", amount: 200000, raise_on: "SIGNING", status: "PAID" });
  await store.insert("activity_logs", { tenant_id: tid, entity_type: "project", entity_id: String(open.ROWID), action: "transition:open", actor_user_id: null, metadata_json: "{}", created_at: "2026-07-01 09:00:00" });
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => NOW });
    return res.body as { success: boolean; data?: any; error?: { code: string } };
  };
  return { store, tid, fr, other, open, opening, call };
}

describe("franchisee overview", () => {
  it("sums the partner's stores, sales, royalties, compliance and attention for staff", async () => {
    const s = await setup();
    const d = (await s.call("mgr", "GET", `/franchisees/${s.fr.ROWID}/overview`)).data;
    expect(d.franchisee).toMatchObject({ display_name: "Yaazh Fashions", portal_users: 1, since: "2026-06-01" });
    expect(d.kpis.stores).toEqual({ trading: 1, opening: 1, pipeline: 0 });
    expect(d.kpis.sales).toMatchObject({ month_to_date: 128000, last_month: { period: "2026-09", net_sales: 650000 }, three_months: 1780000, feed: "CONNECTED" });
    expect(d.kpis.royalty).toMatchObject({ billed_three_months: 90400, waiting: 1, missing: 0, strayed: 1 });
    expect(d.kpis.health).toEqual({ worst_band: "WATCH", average_score: 72, scored: 1 });
    expect(d.kpis.compliance).toMatchObject({ open_actions: 1, lapsing_licences: 1, agreement_expiry: "2031-05-31", last_audit: { audit_code: "AUD-000001", score: 85.1, rating: "GREEN" } });
    // A franchise manager is not finance: no amounts owed, and no money tab.
    expect(d.finance).toBe(false);
    expect(d.kpis.outstanding).toBeNull();
    expect(d.money).toBeNull();
    expect(d.agreements[0].fee_total).toBeUndefined();
    expect(d.royalties.months.map((m: any) => [m.period, m.status])).toEqual([["2026-09", "SUBMITTED"], ["2026-08", "INVOICED"], ["2026-07", "PAID"]]);
    expect(d.royalties.months[0]).toMatchObject({ project_code: "PROJ-000001", pos_net_sales: 650000, reported_net_sales: 590000, strayed: true });
    expect(d.stores.map((x: any) => [x.project_code, x.status, x.health_band, x.city])).toEqual([["PROJ-000002", "IN_PROGRESS", null, null], ["PROJ-000001", "OPENED", "WATCH", "Tiruppur"]]);
    expect(d.compliance.open_actions[0]).toMatchObject({ item_code: "SIZE", overdue: true, project_code: "PROJ-000001" });
    expect(d.compliance.lapsing[0]).toMatchObject({ licence_code: "TRADE" });
    expect(d.attention.map((a: any) => a.kind)).toContain("royalty.review");
    expect(d.attention.map((a: any) => a.kind)).not.toContain("payment");
    expect(d.attention.find((a: any) => a.kind === "royalty.review")).toMatchObject({ level: "due", detail: "Reported below POS by 9.2%" });
    expect(d.activity[0]).toMatchObject({ action: "transition:open", project_code: "PROJ-000001", actor: "System" });
  });

  it("shows finance what is owed, and lists the overdue invoice under attention", async () => {
    const s = await setup();
    const d = (await s.call("fin", "GET", `/franchisees/${s.fr.ROWID}/overview`)).data;
    expect(d.finance).toBe(true);
    expect(d.kpis.outstanding).toEqual({ total: 57584, overdue: 57584, count: 1, overdue_count: 1, oldest_days: 18 });
    expect(d.money.collections).toHaveLength(1);
    expect(d.money.instalments[0]).toMatchObject({ label: "On signing", project_code: "PROJ-000001" });
    expect(d.money.fees[0]).toMatchObject({ agreement_code: "AGR-000001", fee_status: "PAID", fee_total: 590000 });
    expect(d.money.paid_royalty).toBe(31200);
    expect(d.royalties.totals).toEqual({ invoiced_net_sales: 1130000, royalty: 67800, marketing: 22600, outstanding: 57584 });
    expect(d.attention[0]).toMatchObject({ kind: "payment", level: "overdue", due: "2026-09-22" });
  });

  it("lets a franchisee see their own record only, and keeps other staff out", async () => {
    const s = await setup();
    const own = await s.call("pepper", "GET", `/franchisees/${s.fr.ROWID}/overview`);
    expect(own.data.kpis.stores.trading).toBe(1);
    expect(own.data.finance).toBe(true);
    expect((await s.call("stranger", "GET", `/franchisees/${s.fr.ROWID}/overview`)).error?.code).toBe("FRANCHISEE_NOT_FOUND");
    expect((await s.call("legal", "GET", `/franchisees/${s.fr.ROWID}/overview`)).error?.code).toBe("ACCESS_DENIED");
  });
});
