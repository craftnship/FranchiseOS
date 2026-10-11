import { z } from "zod";
import { Row } from "../../common/store";
import { round, toNum, toNumOrNull } from "../../common/values";
import { duePeriods, nextPeriod, periodLabel, periodOf, prevPeriod } from "../../workflows/royalties";
import { parse, Router } from "../router";
import { FUNNEL } from "./dashboards";
import { fetchAll } from "./shared";

// Owner analytics: how opened stores trade (sales, royalty, reporting), how fast stores open after
// signing, and where applications drop out of the funnel. Computed live at pilot scale.

const DAY = 86_400_000;
const querySchema = z.object({
  months: z.coerce.number().int().refine((n) => [3, 6, 12, 24].includes(n), "use 3, 6, 12 or 24").default(12),
  region: z.string().trim().max(60).optional(),
});

const days = (from: unknown, to: unknown) => {
  const a = Date.parse(String(from ?? "").slice(0, 10)), b = Date.parse(String(to ?? "").slice(0, 10));
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / DAY);
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : round((s[m - 1] + s[m]) / 2, 1);
};
const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null);
const pct = (n: number, d: number) => (d ? round((n / d) * 100, 1) : null);
const meta = (r: Row): Row => { try { return JSON.parse(String(r.metadata_json ?? "{}")); } catch { return {}; } };
const at = (r: Row) => String(r.created_at ?? r.CREATEDTIME ?? "").replace(" ", "T");
const invoiced = (r: Row) => r.status === "INVOICED" || r.status === "PAID";
const reported = (r: Row) => r.status !== "RETURNED";

export function analyticsRoutes(r: Router): void {
  r.on("GET", "/analytics", "dashboard.view", async (call) => {
    const q = parse(querySchema, call.query);
    const today = call.now.toISOString().slice(0, 10);
    const [projects, sites, territories, franchisees, apps, agreements, models, reports, logs] = await Promise.all([
      fetchAll(call.repo, "franchise_projects"), fetchAll(call.repo, "sites"), fetchAll(call.repo, "territories"), fetchAll(call.repo, "franchisees"),
      fetchAll(call.repo, "franchise_applications"), fetchAll(call.repo, "agreements"), fetchAll(call.repo, "feasibility_models"),
      fetchAll(call.repo, "sales_reports"), fetchAll(call.repo, "activity_logs", { entity_type: "application" }, 10000),
    ]);
    const byId = (rows: Row[]) => new Map(rows.map((x) => [String(x.ROWID), x]));
    const siteOf = byId(sites), terOf = byId(territories), frOf = byId(franchisees), appOf = byId(apps);
    const modelOf = new Map<string, Row>();
    for (const m of [...models].sort((a, b) => String(a.ROWID).localeCompare(String(b.ROWID), undefined, { numeric: true }))) modelOf.set(String(m.application_id), m);
    const signedOf = new Map<string, Row>();
    for (const a of agreements) if (a.status === "SIGNED" || a.signed_at) signedOf.set(String(a.application_id), a);

    // Where a store or application is: its site's territory, else the application's territory.
    const placeOf = (app: Row | undefined, site: Row | undefined) => {
      const ter = terOf.get(String(site?.territory_id ?? app?.territory_id ?? ""));
      return { region: (ter?.region as string) ?? null, city: (site?.city ?? ter?.city ?? app?.preferred_city ?? null) as string | null };
    };
    const regions = [...new Set(territories.map((t) => t.region).filter(Boolean).map(String))].sort();
    const inRegion = (region: string | null) => !q.region || region === q.region;

    // Months shown: the last `months` finished months, oldest first.
    const last = prevPeriod(periodOf(today));
    const periods: string[] = [];
    for (let p = last; periods.length < q.months; p = prevPeriod(p)) periods.unshift(p);
    const first = periods[0];

    // Sales and royalty, per store and per month.
    const opened = projects.filter((p) => p.status === "OPENED" && p.actual_opening_date);
    const repsOf = new Map<string, Row[]>();
    for (const x of reports) (repsOf.get(String(x.project_id)) ?? repsOf.set(String(x.project_id), []).get(String(x.project_id))!).push(x);
    const series = new Map(periods.map((p) => [p, { period: p, label: periodLabel(p), net_sales: 0, royalty: 0, collected: 0, stores_reporting: 0, stores_due: 0 }]));
    const stores: Row[] = [];
    for (const p of opened) {
      const app = appOf.get(String(p.application_id));
      const place = placeOf(app, siteOf.get(String(p.site_id)));
      if (!inRegion(place.region)) continue;
      const reps = (repsOf.get(String(p.ROWID)) ?? []).filter(reported).sort((a, b) => String(a.period).localeCompare(String(b.period)));
      const due = duePeriods(p, today).filter((x) => x >= first);
      for (const d of due) series.get(d)!.stores_due++;
      const inWindow = reps.filter((x) => String(x.period) >= first && String(x.period) <= last);
      for (const x of inWindow) {
        const s = series.get(String(x.period))!;
        s.net_sales += toNum(x.net_sales); s.stores_reporting++;
        if (invoiced(x)) { s.royalty += toNum(x.royalty_amount) + toNum(x.marketing_amount); s.collected += toNum(x.invoice_total) - toNum(x.invoice_balance); }
      }
      const recent = reps.slice(-3);
      const avgNet = recent.length ? round(recent.reduce((a, x) => a + toNum(x.net_sales), 0) / recent.length) : null;
      const plan = toNumOrNull(modelOf.get(String(p.application_id))?.monthly_revenue);
      const lastRep = reps.at(-1), prevRep = reps.at(-2);
      const fr = frOf.get(String(p.franchisee_id));
      const reportedDue = due.filter((d) => inWindow.some((x) => x.period === d)).length;
      stores.push({
        project_id: String(p.ROWID), project_code: p.project_code, franchisee: fr?.display_name ?? fr?.franchise_code ?? null, ...place,
        opened_on: String(p.actual_opening_date).slice(0, 10), months_due: due.length, months_reported: reportedDue, reporting_pct: pct(reportedDue, due.length),
        last_period: lastRep ? lastRep.period : null, last_net_sales: lastRep ? toNum(lastRep.net_sales) : null,
        change_pct: lastRep && prevRep && nextPeriod(String(prevRep.period)) === lastRep.period && toNum(prevRep.net_sales) ? round((toNum(lastRep.net_sales) / toNum(prevRep.net_sales) - 1) * 100, 1) : null,
        avg_net_sales: avgNet, plan_net_sales: plan, vs_plan_pct: avgNet !== null && plan ? round((avgNet / plan - 1) * 100, 1) : null,
        net_sales: round(inWindow.reduce((a, x) => a + toNum(x.net_sales), 0)),
        royalty: round(inWindow.filter(invoiced).reduce((a, x) => a + toNum(x.royalty_amount) + toNum(x.marketing_amount), 0)),
        unpaid: round(reps.filter((x) => x.status === "INVOICED").reduce((a, x) => a + toNum(x.invoice_balance), 0)),
      });
    }
    stores.sort((a, b) => toNum(b.net_sales) - toNum(a.net_sales) || String(a.project_code).localeCompare(String(b.project_code)));
    const months = [...series.values()].map((s) => ({ ...s, net_sales: round(s.net_sales), royalty: round(s.royalty), collected: round(s.collected) }));
    const totalNet = months.reduce((a, m) => a + m.net_sales, 0);
    const storeMonths = months.reduce((a, m) => a + m.stores_reporting, 0);
    const due = months.reduce((a, m) => a + m.stores_due, 0);
    const vsPlan = stores.map((s) => s.vs_plan_pct).filter((n): n is number => n !== null);

    // Opening speed: agreement signed to store opened, and against the target date.
    const openings = opened.map((p) => {
      const app = appOf.get(String(p.application_id));
      const place = placeOf(app, siteOf.get(String(p.site_id)));
      const ag = signedOf.get(String(p.application_id));
      const signed = ag ? String(ag.signed_at ?? ag.effective_date ?? "").slice(0, 10) || null : null;
      return {
        project_id: String(p.ROWID), project_code: p.project_code, ...place, signed_on: signed, opened_on: String(p.actual_opening_date).slice(0, 10),
        target_opening_date: p.target_opening_date ?? null, days_to_open: signed ? days(signed, p.actual_opening_date) : null,
        days_late: p.target_opening_date ? days(p.target_opening_date, p.actual_opening_date) : null,
      };
    }).filter((o) => inRegion(o.region)).sort((a, b) => b.opened_on.localeCompare(a.opened_on));
    const toOpen = openings.map((o) => o.days_to_open).filter((n): n is number => n !== null && n >= 0);
    const late = openings.map((o) => o.days_late).filter((n): n is number => n !== null);
    const byRegion = [...new Set(openings.map((o) => o.region ?? "No region"))].sort().map((region) => {
      const rows = openings.filter((o) => (o.region ?? "No region") === region);
      const d = rows.map((o) => o.days_to_open).filter((n): n is number => n !== null && n >= 0);
      const l = rows.map((o) => o.days_late).filter((n): n is number => n !== null);
      return { region, opened: rows.length, median_days_to_open: median(d), on_time_pct: pct(l.filter((n) => n <= 0).length, l.length) };
    });

    // Funnel: an application reached a stage if it was ever at that stage or a later one. Days in a
    // stage come from the status transitions in the activity log.
    const idx = (s: unknown) => FUNNEL.indexOf(String(s));
    const scoped = apps.filter((a) => inRegion(placeOf(a, siteOf.get(String(a.site_id))).region));
    const scopedIds = new Set(scoped.map((a) => String(a.ROWID)));
    const moves = new Map<string, { to: string; at: string }[]>();
    for (const l of logs) {
      if (!scopedIds.has(String(l.entity_id)) || !String(l.action).startsWith("transition:")) continue;
      const to = meta(l).to;
      if (!to) continue;
      (moves.get(String(l.entity_id)) ?? moves.set(String(l.entity_id), []).get(String(l.entity_id))!).push({ to: String(to), at: at(l) });
    }
    const furthest = (a: Row) => Math.max(idx(a.status), ...(moves.get(String(a.ROWID)) ?? []).map((m) => idx(m.to)));
    const reach = scoped.map(furthest);
    const stageDays = new Map<string, number[]>();
    for (const [, ms] of moves) {
      ms.sort((a, b) => a.at.localeCompare(b.at));
      for (let i = 0; i < ms.length - 1; i++) {
        const d = (Date.parse(ms[i + 1].at) - Date.parse(ms[i].at)) / DAY;
        if (Number.isFinite(d) && d >= 0) (stageDays.get(ms[i].to) ?? stageDays.set(ms[i].to, []).get(ms[i].to)!).push(round(d, 1));
      }
    }
    const stages = FUNNEL.map((stage, i) => {
      const reached = reach.filter((n) => n >= i).length;
      const next = i < FUNNEL.length - 1 ? reach.filter((n) => n >= i + 1).length : null;
      return { stage, reached, current: scoped.filter((a) => a.status === stage).length, to_next_pct: next === null ? null : pct(next, reached), median_days: median(stageDays.get(stage) ?? []) };
    });
    const signedIdx = idx("AGREEMENT_SIGNED"), submittedIdx = idx("SUBMITTED");
    const submitted = reach.filter((n) => n >= submittedIdx).length;
    const closed = ["REJECTED", "WITHDRAWN", "ON_HOLD"].map((s) => ({ status: s, count: scoped.filter((a) => a.status === s).length }));

    return {
      months: q.months, region: q.region ?? null, regions, period_from: first, period_to: last,
      sales: {
        series: months, stores,
        totals: {
          net_sales: round(totalNet), royalty: round(months.reduce((a, m) => a + m.royalty, 0)), collected: round(months.reduce((a, m) => a + m.collected, 0)),
          unpaid: round(stores.reduce((a, s) => a + toNum(s.unpaid), 0)), stores: stores.length,
          avg_store_month: storeMonths ? round(totalNet / storeMonths) : null, reporting_pct: pct(storeMonths, due), median_vs_plan_pct: median(vsPlan),
        },
      },
      openings: { items: openings, median_days_to_open: median(toOpen), avg_days_late: avg(late), on_time_pct: pct(late.filter((n) => n <= 0).length, late.length), by_region: byRegion },
      pipeline: { stages, closed, applications: scoped.length, submitted, signed: reach.filter((n) => n >= signedIdx).length, signed_pct: pct(reach.filter((n) => n >= signedIdx).length, submitted) },
    };
  });
}
