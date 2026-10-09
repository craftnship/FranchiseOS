import { z } from "zod";
import { Row } from "../../common/store";
import { round, toBool, toNum, toNumOrNull } from "../../common/values";
import { parse, Router } from "../router";
import { fetchAll } from "./shared";
import { isDelayed } from "./projects";

// Executive dashboards (spec §24, FOS-059..063). Every KPI carries `drill`: the list route and
// query that returns the records behind the number. Computed live from Data Store at pilot scale.

interface Kpi { value: number | null; drill?: { path: string; query: Record<string, string> } }
const kpi = (value: number | null, path?: string, query: Record<string, string> = {}): Kpi => (path ? { value, drill: { path, query } } : { value });

export const FUNNEL = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "SITE_SUBMITTED", "FEASIBILITY_REVIEW", "APPROVAL_PENDING", "APPROVED", "AGREEMENT_PENDING", "AGREEMENT_SIGNED", "ONBOARDING", "ACTIVE"];
const OPEN_APPS = FUNNEL.slice(0, FUNNEL.indexOf("AGREEMENT_SIGNED"));
const ACTIVE_PROJECTS = ["PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];

const avg = (xs: number[]) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const month = (d: unknown) => (d ? String(d).slice(0, 7) : null);

function countBy(rows: Row[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const k = String(r[key] ?? "NONE"); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export function dashboardRoutes(r: Router): void {
  r.on("GET", "/dashboard/network", "dashboard.view", async (call) => {
    const today = call.now.toISOString().slice(0, 10);
    const [franchisees, apps, projects, feasibility] = await Promise.all([
      fetchAll(call.repo, "franchisees"), fetchAll(call.repo, "franchise_applications"), fetchAll(call.repo, "franchise_projects"), fetchAll(call.repo, "feasibility_models"),
    ]);
    const openApps = apps.filter((a) => OPEN_APPS.includes(String(a.status)));
    const active = projects.filter((p) => ACTIVE_PROJECTS.includes(String(p.status)));
    return {
      active_franchisees: kpi(franchisees.filter((f) => f.status === "ACTIVE").length, "/franchisees", { status: "ACTIVE" }),
      active_locations: kpi(projects.filter((p) => p.status === "OPENED").length, "/projects", { status: "OPENED" }),
      applications: kpi(openApps.length, "/applications", { status: OPEN_APPS.join(",") }),
      pipeline_value: kpi(round(openApps.reduce((s, a) => s + toNum(a.investment_capacity), 0)), "/applications", { status: OPEN_APPS.join(",") }),
      openings: kpi(active.length, "/projects", { status: ACTIVE_PROJECTS.join(",") }),
      delayed_openings: kpi(projects.filter((p) => isDelayed(p, today)).length, "/projects", { delayed: "true" }),
      // Network health: average stored readiness of projects in flight (Phase 2 adds audits).
      network_health: kpi(avg(active.map((p) => toNumOrNull(p.readiness_score)).filter((n): n is number => n !== null)), "/projects", { status: ACTIVE_PROJECTS.join(",") }),
      average_payback_months: kpi(avg(feasibility.filter((f) => toBool(f.passed)).map((f) => toNumOrNull(f.payback_months)).filter((n): n is number => n !== null))),
    };
  });

  r.on("GET", "/dashboard/pipeline", "dashboard.view", async (call) => {
    const apps = await fetchAll(call.repo, "franchise_applications");
    const counts = countBy(apps, "status");
    // Funnel stage n counts every application that reached it, so later stages include earlier ones.
    const reached = FUNNEL.map((s, i) => ({ stage: s, count: FUNNEL.slice(i).reduce((n, later) => n + (counts[later] ?? 0), 0) }));
    return {
      funnel: reached.map((f) => ({ ...f, current: counts[f.stage] ?? 0, drill: { path: "/applications", query: { status: f.stage } } })),
      closed: ["REJECTED", "WITHDRAWN", "ON_HOLD"].map((s) => ({ status: s, ...kpi(counts[s] ?? 0, "/applications", { status: s }) })),
      pipeline_value: kpi(round(apps.filter((a) => OPEN_APPS.includes(String(a.status))).reduce((s, a) => s + toNum(a.investment_capacity), 0)), "/applications", { status: OPEN_APPS.join(",") }),
      conversion_pct: apps.length ? round(((counts.AGREEMENT_SIGNED ?? 0) + (counts.ONBOARDING ?? 0) + (counts.ACTIVE ?? 0)) / apps.length * 100) : null,
    };
  });

  r.on("GET", "/dashboard/openings", "dashboard.view", async (call) => {
    const q = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }), call.query);
    const today = call.now.toISOString().slice(0, 10);
    const projects = await fetchAll(call.repo, "franchise_projects");
    const byMonth: Record<string, { planned: number; opened: number }> = {};
    for (const p of projects) {
      const opened = p.status === "OPENED" || p.status === "CLOSED";
      const m = month(opened ? p.actual_opening_date ?? p.target_opening_date : p.target_opening_date);
      if (!m) continue;
      byMonth[m] ??= { planned: 0, opened: 0 };
      byMonth[m][opened ? "opened" : "planned"]++;
    }
    const start = new Date(Date.UTC(call.now.getUTCFullYear(), call.now.getUTCMonth() - Math.floor(q.months / 2), 1));
    const series = Array.from({ length: q.months }, (_, i) => {
      const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString().slice(0, 7);
      return { month: m, ...(byMonth[m] ?? { planned: 0, opened: 0 }) };
    });
    const delayed = projects.filter((p) => isDelayed(p, today));
    return {
      by_status: Object.entries(countBy(projects, "status")).map(([status, n]) => ({ status, ...kpi(n, "/projects", { status }) })),
      by_month: series,
      delayed: { ...kpi(delayed.length, "/projects", { delayed: "true" }), items: delayed.map((p) => ({ id: p.ROWID, project_code: p.project_code, target_opening_date: p.target_opening_date, readiness_rag: p.readiness_rag })) },
    };
  });

  r.on("GET", "/dashboard/risk", "dashboard.view", async (call) => {
    const projects = (await fetchAll(call.repo, "franchise_projects")).filter((p) => ACTIVE_PROJECTS.includes(String(p.status)));
    const atRisk = projects
      .filter((p) => p.status === "AT_RISK" || p.risk_level === "HIGH")
      .sort((a, b) => toNum(a.readiness_score) - toNum(b.readiness_score));
    return {
      rag: ["GREEN", "AMBER", "RED"].map((rag) => ({ rag, ...kpi(projects.filter((p) => p.readiness_rag === rag).length, "/projects", { rag }) })),
      at_risk: { ...kpi(atRisk.length, "/projects", { risk_level: "HIGH" }), items: atRisk.map((p) => ({ id: p.ROWID, project_code: p.project_code, status: p.status, readiness_score: p.readiness_score, readiness_rag: p.readiness_rag, target_opening_date: p.target_opening_date })) },
    };
  });

  r.on("GET", "/dashboard/territories", "dashboard.view", async (call) => {
    const territories = await fetchAll(call.repo, "territories");
    return {
      by_status: Object.entries(countBy(territories, "status")).map(([status, n]) => ({ status, ...kpi(n, "/territories", { status }) })),
      // Map points for the opportunity map; territories without coordinates are listed but not plotted.
      territories: territories.map((t) => ({ id: t.ROWID, territory_code: t.territory_code, name: t.name, city: t.city, status: t.status, opportunity_score: toNumOrNull(t.opportunity_score), latitude: toNumOrNull(t.latitude), longitude: toNumOrNull(t.longitude) }))
        .sort((a, b) => (b.opportunity_score ?? -1) - (a.opportunity_score ?? -1)),
    };
  });
}
