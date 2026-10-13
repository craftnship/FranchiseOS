import { logActivity } from "../common/audit";
import { Mailer, TenantContext } from "../common/context";
import { log } from "../common/logger";
import { Row, Store, TenantRepo } from "../common/store";
import { round, toNum, toNumOrNull } from "../common/values";
import { HealthBand, HealthInputs, HealthResult, HealthSettings, healthSettings, scoreHealth } from "../scoring/health";
import { auditSettings, nextDue } from "./audits";
import { addDays } from "./launch";
import { deliver, usersInRoles } from "./notifications";
import { daysLate, owedRows, projectOfOwed } from "./receivables";
import { duePeriods, nextPeriod, periodOf, prevPeriod, ratesFrom, royaltySettings, tradedFullMonth } from "./royalties";

// Franchisee health (docs/health-score.md): gathers each trading store's inputs from what FranchiseOS
// already holds, scores it (scoring/health.ts), keeps the result on the project and a row per day in
// store_health, and tells the brand team when a store enters At risk or recovers.

const OPEN_ACTION = ["OPEN", "SUBMITTED"];
const ALERT_ROLES = ["FRANCHISE_MANAGER", "OPERATIONS_MANAGER"];
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

export const settingsOf = (tenant: Row | null): Record<string, unknown> => { try { return tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { return {}; } };
export const healthSettingsFor = (tenant: Row | null): HealthSettings => healthSettings(settingsOf(tenant));

/** Every row of a table for the tenant; the store pages past the 300-row cap. */
const allRows = (repo: TenantRepo, table: string, where: Record<string, string> = {}): Promise<Row[]> => repo.findMany(table, where, { orderBy: "ROWID" });

export interface StoreHealth extends HealthResult { project: Row; region: string | null; inputs: HealthInputs }

/** Scores every trading store of the tenant from the tables as they stand today. */
export async function computeNetworkHealth(store: Store, ctx: Pick<TenantContext, "tenantId">, today: string): Promise<{ stores: StoreHealth[]; settings: HealthSettings }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const [tenant, projects, sites, territories, apps, models, reports, agreements, instalments, audits, actions, licences] = await Promise.all([
    store.findOne("tenants", { ROWID: ctx.tenantId }), allRows(repo, "franchise_projects", { status: "OPENED" }), allRows(repo, "sites"), allRows(repo, "territories"),
    allRows(repo, "franchise_applications"), allRows(repo, "feasibility_models"), allRows(repo, "sales_reports"), allRows(repo, "agreements"),
    allRows(repo, "fee_instalments"), allRows(repo, "audits", { status: "COMPLETED" }), allRows(repo, "corrective_actions"), allRows(repo, "licences"),
  ]);
  const settings = healthSettingsFor(tenant);
  const audit = auditSettings(tenant);
  const dueDay = royaltySettings(tenant).report_due_day;
  const by = (rows: Row[]) => new Map(rows.map((x) => [String(x.ROWID), x]));
  const siteOf = by(sites), terOf = by(territories), appOf = by(apps);
  const latestModel = new Map<string, Row>();
  for (const m of [...models].sort((a, b) => String(a.ROWID).localeCompare(String(b.ROWID), undefined, { numeric: true }))) latestModel.set(String(m.application_id), m);
  const owed = owedRows(agreements, instalments, reports);
  const ownerOf = projectOfOwed(projects);
  const opened = projects.filter((p) => p.actual_opening_date);

  const stores = opened.map((p): StoreHealth => {
    const pid = String(p.ROWID);
    const site = siteOf.get(String(p.site_id ?? ""));
    const ter = terOf.get(String(site?.territory_id ?? appOf.get(String(p.application_id ?? ""))?.territory_id ?? ""));
    const model = latestModel.get(String(p.application_id)) ?? null;
    const mine = reports.filter((x) => String(x.project_id) === pid && x.status !== "RETURNED").sort((a, b) => String(a.period).localeCompare(String(b.period)));

    // Sales: the last three full reported months against the plan.
    const recent = mine.filter((x) => tradedFullMonth(p.actual_opening_date, x.period)).slice(-3);
    const plan = toNumOrNull(model?.monthly_revenue);
    const avg = recent.length ? recent.reduce((a, x) => a + toNum(x.net_sales), 0) / recent.length : null;
    const sales = avg !== null && plan ? { vs_plan_pct: round((avg / plan - 1) * 100, 1), months: recent.length, months_under: recent.filter((x) => toNum(x.net_sales) < plan).length } : null;

    // Payments: the same owed items the receivables panel ages.
    const owedHere = owed.filter((o) => ownerOf(o.row) === pid);
    const rates = ratesFrom(p, model, tenant);
    const monthly = avg !== null && rates.royalty_pct !== null ? avg * (rates.royalty_pct + (rates.marketing_fund_pct ?? 0)) / 100 : null;
    const overdueHere = owedHere.filter((o) => daysLate(o.due, today) > 0);
    const payments = owedHere.length ? {
      owed: round(owedHere.reduce((a, o) => a + o.amount, 0)), overdue: round(overdueHere.reduce((a, o) => a + o.amount, 0)),
      oldest_days: Math.max(0, ...overdueHere.map((o) => daysLate(o.due, today))), monthly_royalty: monthly === null ? null : round(monthly),
    } : { owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: monthly === null ? null : round(monthly) };

    // Compliance: the latest audit, what is open against it, licences and the next audit.
    const done = audits.filter((a) => String(a.project_id) === pid).sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    const open = actions.filter((a) => String(a.project_id) === pid && OPEN_ACTION.includes(String(a.status)));
    const due = nextDue(p, done[0] ?? null, audit);
    const compliance = {
      audit_score: toNumOrNull(done[0]?.score), critical_open: open.filter((a) => a.severity === "CRITICAL").length,
      overdue_actions: open.filter((a) => a.status === "OPEN" && a.due_date && day(a.due_date)! < today).length,
      expired_licences: licences.filter((l) => String(l.project_id) === pid && l.status === "EXPIRED").length,
      audit_overdue: !!due && due < today,
    };

    // Reporting: the last six months due, judged by the tenant's report due day.
    const periods = duePeriods(p, today).slice(-6).filter((per) => `${nextPeriod(per)}-${String(dueDay).padStart(2, "0")}` <= today);
    const byPeriod = new Map(mine.map((x) => [String(x.period), x]));
    let onTime = 0, late = 0;
    for (const per of periods) {
      const r = byPeriod.get(per);
      if (!r) continue;
      const dueOn = `${nextPeriod(per)}-${String(dueDay).padStart(2, "0")}`;
      if (!r.submitted_at || day(r.submitted_at)! <= dueOn) onTime++; else late++;
    }
    const reporting = periods.length ? { due: periods.length, on_time: onTime, late } : null;

    const inputs: HealthInputs = { sales, payments, compliance, reporting, customer: null };
    return { ...scoreHealth(inputs, settings), project: p, region: (ter?.region as string | null) ?? null, inputs };
  });
  return { stores, settings };
}

export interface HealthRefresh { stores: number; scored: number; changed: number; alerted: number }

/**
 * Recomputes every trading store, keeps the result on the project and in today's store_health row, logs
 * a band change, and alerts the brand team once when a store enters At risk or recovers to Healthy.
 */
export async function refreshStoreHealth(store: Store, ctx: TenantContext, today: string): Promise<HealthRefresh> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const { stores } = await computeNetworkHealth(store, ctx, today);
  const out: HealthRefresh = { stores: stores.length, scored: 0, changed: 0, alerted: 0 };
  const regional = (await usersInRoles(store, ctx.tenantId, ["REGIONAL_MANAGER"])).filter((u) => u.region);
  for (const s of stores) {
    const pid = String(s.project.ROWID);
    const before = (s.project.health_band as HealthBand | null) ?? null;
    const patch: Row = {
      health_score: s.score, health_band: s.band, health_updated_on: today,
      health_json: JSON.stringify({ parts: s.parts, reasons: s.reasons, capped: s.capped, inputs: s.inputs }),
    };
    if (s.band) {
      out.scored++;
      const key = `${ctx.tenantId}:${pid}:${today}`;
      const snap = { project_id: pid, as_of: today, score: s.score, band: s.band, parts_json: JSON.stringify(s.parts.map((p) => ({ part: p.part, score: p.score }))), health_key: key };
      const existing = await repo.findOne("store_health", { health_key: key });
      if (existing) await repo.update("store_health", String(existing.ROWID), snap); else await repo.insert("store_health", snap);
    }
    if (before !== s.band) {
      out.changed++;
      await logActivity(store, ctx, { entityType: "project", entityId: pid, action: "health:band_changed", metadata: { from: before, to: s.band, score: s.score, reasons: s.reasons.map((r) => r.text) } });
    }
    // Entering At risk, or coming back to Healthy from it, is worth a word; each change once.
    const alerted = (s.project.health_alerted_band as string | null) ?? null;
    const enteredRisk = s.band === "AT_RISK" && alerted !== "AT_RISK";
    const recovered = s.band === "HEALTHY" && alerted === "AT_RISK";
    if (enteredRisk || recovered) {
      const code = String(s.project.project_code);
      const why = s.reasons.map((r) => r.money ?? r.text).join("; ");
      const n = await deliver(store, ctx, {
        kind: enteredRisk ? "health.at_risk" : "health.recovered", entityType: "project", entityId: pid,
        roles: ALERT_ROLES, userIds: regional.filter((u) => String(u.region).toLowerCase() === String(s.region ?? "").toLowerCase()).map((u) => String(u.ROWID)),
        title: enteredRisk ? `${code} is at risk (health ${s.score})` : `${code} is healthy again (health ${s.score})`,
        body: enteredRisk ? `${why}.` : `Back from at risk. ${why}.`, link: `/projects/${pid}`, dedupe: `health:${pid}:${s.band}:${today}`,
      });
      if (n) out.alerted++;
      patch.health_alerted_band = s.band;
    }
    await repo.update("franchise_projects", pid, patch);
  }
  return out;
}

/** The daily job step: every active tenant's trading stores. */
export async function runStoreHealthJob(store: Store, opts: { today: string; now?: Date; requestId: string; mailer?: Mailer }): Promise<HealthRefresh & { tenants: number; failed: number }> {
  const out = { tenants: 0, failed: 0, stores: 0, scored: 0, changed: 0, alerted: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    out.tenants++;
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId, mailer: opts.mailer };
    try {
      const r = await refreshStoreHealth(store, ctx, opts.today);
      out.stores += r.stores; out.scored += r.scored; out.changed += r.changed; out.alerted += r.alerted;
    } catch (e) {
      out.failed++;
      log("warn", "job.store_health_failed", { tenant_id: tenantId, request_id: opts.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  log("info", "job.store_health", { request_id: opts.requestId, ...out });
  return out;
}

/** The history kept for a store, oldest first, trimmed to the last `days`. */
export async function healthHistory(repo: TenantRepo, projectId: string, today: string, days = 182): Promise<{ as_of: string; score: number | null; band: string | null }[]> {
  const from = addDays(today, -days);
  const rows = await repo.findMany("store_health", { project_id: projectId }, { orderBy: "as_of", desc: true, limit: days + 1 });
  return rows.filter((r) => String(r.as_of).slice(0, 10) >= from).map((r) => ({ as_of: String(r.as_of).slice(0, 10), score: toNumOrNull(r.score), band: (r.band as string) ?? null })).reverse();
}

