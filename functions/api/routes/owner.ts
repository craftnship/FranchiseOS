import { z } from "zod";
import { Row } from "../../common/store";
import { round, toBool, toNum, toNumOrNull } from "../../common/values";
import { duePeriods, ratesFrom, tradedFullMonth, periodLabel, periodOf, prevPeriod } from "../../workflows/royalties";
import { addDays } from "../../workflows/launch";
import { AGE_BUCKETS, bucketOf, daysBetween, owedRows, projectOfOwed as ownerOfOwed } from "../../workflows/receivables";
import { auditSettings, nextDue } from "../../workflows/audits";
import { feedStatus, posSettings } from "../../workflows/posSales";
import { OPEN_COLLECTION, paymentBehaviour } from "../../workflows/collections";
import { parse, Router } from "../router";
import { fetchAll } from "./shared";
import { allowed } from "../../common/rbac";
import { regionFor, scopeOf } from "./regions";

// The brand owner's view on the dashboard: what the trading network earns, what is owed, how
// stores rank, how compliant they are, and the items waiting on the brand team today.
// Computed live from Data Store at pilot scale, like the other dashboards. Royalty billing, receivables
// and unpaid amounts are only for callers with finance.view; everyone else sees sales and operations.

const OPEN_ACTION = ["OPEN", "SUBMITTED"];
const querySchema = z.object({ months: z.coerce.number().int().refine((n) => [1, 3, 6, 12].includes(n), "use 1, 3, 6 or 12").default(1) });

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const pct = (n: number, d: number) => (d ? round((n / d) * 100, 1) : null);
const change = (now: number, before: number) => (before ? round((now / before - 1) * 100, 1) : null);
const sum = <T,>(rows: T[], f: (r: T) => number) => round(rows.reduce((a, r) => a + f(r), 0));
const reported = (r: Row) => r.status !== "RETURNED";
const invoiced = (r: Row) => r.status === "INVOICED" || r.status === "PAID";

export type Tone = "bad" | "warn" | "info";
export interface AttentionItem { kind: string; tone: Tone; title: string; detail: string; href: string; date: string | null }
const TONE_ORDER: Record<Tone, number> = { bad: 0, warn: 1, info: 2 };

/** The last `n` finished months, oldest first. */
function window(last: string, n: number): string[] {
  const out: string[] = [];
  for (let p = last; out.length < n; p = prevPeriod(p)) out.unshift(p);
  return out;
}

/** A store's place in plain words: its territory name, else its site's city, else its code. */
export function storeNamer(projects: Row[], sites: Row[], territories: Row[], apps: Row[], franchisees: Row[]) {
  const by = (rows: Row[]) => new Map(rows.map((x) => [String(x.ROWID), x]));
  const siteOf = by(sites), terOf = by(territories), appOf = by(apps), frOf = by(franchisees), projOf = by(projects);
  return (projectId: unknown) => {
    const p = projOf.get(String(projectId));
    const site = siteOf.get(String(p?.site_id ?? ""));
    const app = appOf.get(String(p?.application_id ?? ""));
    const ter = terOf.get(String(site?.territory_id ?? app?.territory_id ?? ""));
    const fr = frOf.get(String(p?.franchisee_id ?? ""));
    return {
      name: String(ter?.name ?? site?.city ?? p?.project_code ?? "Store"),
      city: (site?.city ?? ter?.city ?? null) as string | null,
      region: (ter?.region ?? null) as string | null,
      franchisee: (fr?.display_name ?? fr?.franchise_code ?? null) as string | null,
      area_sqft: toNumOrNull(site?.area_sqft),
    };
  };
}

export function ownerRoutes(r: Router): void {
  r.on("GET", "/dashboard/owner", "dashboard.view", async (call) => {
    const q = parse(querySchema, call.query);
    const finance = await allowed(call.ctx, "finance.view", call.permissions);
    const today = call.now.toISOString().slice(0, 10);
    const [allProjects, sites, territories, allApps, franchisees, allModels, allReports, allAgreements, allInstalments, allAudits, allActions, allLicences, allOrders, allApprovals, tenant] = await Promise.all([
      fetchAll(call.repo, "franchise_projects"), fetchAll(call.repo, "sites"), fetchAll(call.repo, "territories"), fetchAll(call.repo, "franchise_applications"),
      fetchAll(call.repo, "franchisees"), fetchAll(call.repo, "feasibility_models"), fetchAll(call.repo, "sales_reports"), fetchAll(call.repo, "agreements"),
      fetchAll(call.repo, "fee_instalments"), fetchAll(call.repo, "audits"), fetchAll(call.repo, "corrective_actions"), fetchAll(call.repo, "licences"),
      fetchAll(call.repo, "purchase_orders"), fetchAll(call.repo, "approval_instances", { status: "PENDING" }), call.store.findOne("tenants", { ROWID: call.ctx.tenantId }),
    ]);
    const place = storeNamer(allProjects, sites, territories, allApps, franchisees);
    // Limited to one region when asked, or when the caller is (regions.ts).
    const { region, locked } = regionFor(call);
    const scope = scopeOf(region, locked, { territories, sites, apps: allApps, projects: allProjects });
    const inProject = (x: Row) => scope.projectId(x.project_id);
    const projects = allProjects.filter(scope.project), apps = allApps.filter(scope.application);
    const models = allModels.filter((m) => scope.applicationId(m.application_id));
    const reports = allReports.filter(inProject), audits = allAudits.filter(inProject), actions = allActions.filter(inProject), licences = allLicences.filter(inProject), orders = allOrders.filter(inProject);
    const agreements = allAgreements.filter((a) => scope.applicationId(a.application_id));
    const agreementIds = new Set(agreements.map((a) => String(a.ROWID)));
    const instalments = region ? allInstalments.filter((i) => agreementIds.has(String(i.agreement_id)) || inProject(i)) : allInstalments;
    const approvals = region ? allApprovals.filter((a) => a.entity_type === "application" && scope.applicationId(a.entity_id)) : allApprovals;
    const projOf = new Map(projects.map((p) => [String(p.ROWID), p]));
    const opened = projects.filter((p) => p.status === "OPENED" && p.actual_opening_date);
    const live = (pid: unknown) => { const p = projOf.get(String(pid)); return !!p && p.status !== "CLOSED"; };
    // POS coverage: stores whose daily sales arrive from their POS (docs/pos-sales.md).
    const pos = posSettings(tenant);
    const feedOf = (p: Row) => feedStatus(p, today, pos);
    const posFeed = { connected: opened.filter((p) => feedOf(p) === "CONNECTED").length, stale: opened.filter((p) => feedOf(p) === "STALE").length, total: opened.length, basis: pos.royalty_basis };

    // Revenue: the chosen window of finished months against the same length just before it.
    const last = prevPeriod(periodOf(today));
    const cur = window(last, q.months);
    const prev = window(prevPeriod(cur[0]), q.months);
    const trend = window(last, 12);
    const inP = (ps: string[]) => (x: Row) => ps.includes(String(x.period)) && reported(x);
    // Royalty a submitted report will raise once approved, at the store's rates (as approval works it out).
    const latestModel = new Map<string, Row>();
    for (const m of [...models].sort((a, b) => String(a.ROWID).localeCompare(String(b.ROWID), undefined, { numeric: true }))) latestModel.set(String(m.application_id), m);
    const expectedRoyalty = (x: Row) => {
      const p = projOf.get(String(x.project_id));
      const r = p ? ratesFrom(p, latestModel.get(String(p.application_id)) ?? null, tenant) : null;
      return r?.royalty_pct == null ? null : toNum(x.net_sales) * (r.royalty_pct + (r.marketing_fund_pct ?? 0)) / 100;
    };
    const totals = (ps: string[]) => {
      const rows = reports.filter(inP(ps));
      const waiting = rows.filter((x) => x.status === "SUBMITTED");
      const due = opened.reduce((a, p) => a + duePeriods(p, today).filter((d) => ps.includes(d)).length, 0);
      return {
        net_sales: sum(rows, (x) => toNum(x.net_sales)),
        royalty: sum(rows.filter(invoiced), (x) => toNum(x.royalty_amount) + toNum(x.marketing_amount)),
        collected: sum(rows.filter(invoiced), (x) => toNum(x.invoice_total) - toNum(x.invoice_balance)),
        reports: rows.length, due,
        awaiting_review: waiting.length,
        royalty_pending: sum(waiting, (x) => expectedRoyalty(x) ?? 0),
      };
    };
    const now = totals(cur), before = totals(prev);
    const series = trend.map((p) => { const t = totals([p]); return { period: p, label: periodLabel(p), net_sales: t.net_sales, royalty: t.royalty }; });

    // Receivables: unpaid fee and royalty invoices, aged by days past their due date (workflows/receivables.ts).
    const owed = owedRows(agreements, instalments, reports);
    const projectOfOwed = ownerOfOwed(projects);
    const ageing = AGE_BUCKETS.map(([key, label]) => ({ key, label, amount: sum(owed.filter((o) => bucketOf(o.due, today) === key), (o) => o.amount) }));
    const overdueOwed = owed.filter((o) => bucketOf(o.due, today) !== "current");
    // How the network pays (docs/collections.md): the last 90 days' invoices, and the worklist's open items.
    const behaviour = finance ? paymentBehaviour(agreements, instalments, reports, today) : null;
    const chased = finance ? (await fetchAll(call.repo, "collections")).filter((c) => OPEN_COLLECTION.includes(String(c.status))) : [];
    const chasedBySource = new Map(chased.map((c) => [`${c.kind}:${c.source_id}`, c]));
    const chaseOf = (o: { kind: string; row: Row }) => chasedBySource.get(`${o.kind === "royalty" ? "ROYALTY" : o.row.agreement_code ? "FEE" : "INSTALMENT"}:${o.row.ROWID}`) ?? null;

    // Store league: every opened store on its last three reported months against plan.
    const settings = auditSettings(tenant);
    const planOf = new Map<string, number | null>();
    for (const m of models) planOf.set(String(m.application_id), toNumOrNull(m.monthly_revenue));
    const doneAudits = audits.filter((a) => a.status === "COMPLETED").sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    const latestAudit = (pid: string) => doneAudits.find((a) => String(a.project_id) === pid) ?? null;
    const openActions = actions.filter((a) => OPEN_ACTION.includes(String(a.status)));
    const stores = opened.map((p) => {
      const pid = String(p.ROWID), where = place(pid);
      const reps = reports.filter((x) => String(x.project_id) === pid && reported(x)).sort((a, b) => String(a.period).localeCompare(String(b.period)));
      const recent = reps.filter((x) => tradedFullMonth(p.actual_opening_date, x.period)).slice(-3);
      const avg = recent.length ? round(recent.reduce((a, x) => a + toNum(x.net_sales), 0) / recent.length) : null;
      const plan = planOf.get(String(p.application_id)) ?? null;
      const audit = latestAudit(pid);
      return {
        project_id: pid, project_code: p.project_code, ...where, opened_on: day(p.actual_opening_date),
        avg_net_sales: avg, plan_net_sales: plan, vs_plan_pct: avg !== null && plan ? round((avg / plan - 1) * 100, 1) : null,
        sales_per_sqft: avg !== null && where.area_sqft ? Math.round(avg / where.area_sqft) : null,
        last_period: reps.at(-1)?.period ?? null,
        audit_score: audit ? toNumOrNull(audit.score) : null, audit_rating: audit?.rating ?? null, audit_id: audit ? String(audit.ROWID) : null,
        open_actions: openActions.filter((a) => String(a.project_id) === pid).length,
        unpaid: finance ? sum(owed.filter((o) => projectOfOwed(o.row) === pid), (o) => o.amount) : null,
        days_to_pay: finance ? paymentBehaviour(agreements, instalments, reports, today, { days: 180, projectId: pid, projectOf: projectOfOwed }).days_to_pay : null,
        health_score: toNumOrNull(p.health_score), health_band: (p.health_band as string | null) ?? null,
      };
    }).sort((a, b) => (b.avg_net_sales ?? -1) - (a.avg_net_sales ?? -1) || String(a.project_code).localeCompare(String(b.project_code)));

    // Compliance: latest audit per opened store, corrective actions, licences and audits falling due.
    const rated = (rating: string) => stores.filter((s) => s.audit_rating === rating).length;
    const auditDue = opened.filter((p) => { const d = nextDue(p, latestAudit(String(p.ROWID)), settings); return !!d && d < today && !audits.some((a) => String(a.project_id) === String(p.ROWID) && ["SCHEDULED", "IN_PROGRESS"].includes(String(a.status))); });
    const liveLicences = licences.filter((l) => live(l.project_id));
    const expiring = (days: number) => liveLicences.filter((l) => l.status === "ISSUED" && l.expires_on && day(l.expires_on)! >= today && day(l.expires_on)! <= addDays(today, days));
    const scores = stores.map((s) => s.audit_score).filter((n): n is number => n !== null);
    const compliance = {
      audits: { green: rated("GREEN"), amber: rated("AMBER"), red: rated("RED"), not_audited: stores.filter((s) => !s.audit_rating).length, overdue: auditDue.length, average_score: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 1) : null },
      actions: { open: openActions.length, overdue: openActions.filter((a) => a.status === "OPEN" && a.due_date && day(a.due_date)! < today).length, critical: openActions.filter((a) => a.severity === "CRITICAL").length, waiting_review: openActions.filter((a) => a.status === "SUBMITTED").length },
      licences: { expired: liveLicences.filter((l) => l.status === "EXPIRED").length, expiring_30: expiring(30).length, expiring_90: expiring(90).length },
    };

    // Needs your attention: each item names the store and links to where it's handled.
    const items: AttentionItem[] = [];
    const add = (i: AttentionItem) => items.push(i);
    const appOf = new Map(apps.map((a) => [String(a.ROWID), a]));
    for (const a of approvals) {
      const app = appOf.get(String(a.entity_id));
      const due = day(a.step_due_at);
      const late = !!a.step_due_at && new Date(String(a.step_due_at)) < call.now;
      add({ kind: "Approval", tone: late ? "bad" : "warn", title: `${app?.application_code ?? "Application"}${app?.preferred_city ? ` · ${app.preferred_city}` : ""} waiting for approval`, detail: late ? `Step overdue since ${due}` : due ? `Step due ${due}` : "Waiting for a decision", href: "/approvals?scope=all", date: due });
    }
    for (const x of reports.filter((x) => x.status === "SUBMITTED")) {
      add({ kind: "Sales report", tone: "info", title: `${place(x.project_id).name} ${periodLabel(String(x.period))} sales to review`, detail: "Approve to raise the royalty invoice", href: "/royalties", date: day(x.submitted_at) });
    }
    // The POS figure and the franchisee's report disagree by more than the tolerance: finance decides which to bill on.
    for (const x of reports.filter((x) => x.status === "SUBMITTED" && x.variance_pct != null && Math.abs(toNum(x.variance_pct)) > pos.pos_variance_tolerance_pct)) {
      const v = toNum(x.variance_pct), fmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
      add({ kind: "POS", tone: "warn", title: `${place(x.project_id).name} ${periodLabel(String(x.period))}: ${v < 0 ? `sales under-reported by ${Math.abs(Math.round(v))}%` : `report ${Math.abs(Math.round(v))}% above POS sales`}`, detail: `POS ${fmt(toNum(x.pos_net_sales))} · Reported ${fmt(toNum(x.reported_net_sales ?? x.net_sales))} · Royalty billed on ${x.basis === "POS" ? "POS" : "the report"}`, href: `/projects/${x.project_id}`, date: day(x.submitted_at) });
    }
    for (const p of opened.filter((p) => feedOf(p) === "STALE")) {
      add({ kind: "POS", tone: "warn", title: `${place(p.ROWID).name} POS feed stale`, detail: `Last day of sales ${day(p.pos_last_day)}; the franchisee may need to reconnect Zoho Books`, href: `/projects/${p.ROWID}`, date: day(p.pos_last_day) });
    }
    for (const x of reports.filter((x) => x.status === "RETURNED")) {
      add({ kind: "Sales report", tone: "warn", title: `${place(x.project_id).name} ${periodLabel(String(x.period))} report returned`, detail: x.review_note ? String(x.review_note).slice(0, 120) : "Waiting for the franchisee to resubmit", href: "/royalties", date: day(x.reviewed_at) });
    }
    for (const p of opened) {
      if (duePeriods(p, today).includes(last) && !reports.some((x) => String(x.project_id) === String(p.ROWID) && x.period === last)) {
        add({ kind: "Sales report", tone: "warn", title: `${place(p.ROWID).name} ${periodLabel(last)} sales not reported`, detail: "No report from the franchisee yet", href: "/royalties", date: null });
      }
    }
    for (const o of finance ? overdueOwed : []) {
      const pid = projectOfOwed(o.row);
      const who = pid ? place(pid).name : String(o.row.agreement_code ?? "Agreement");
      const label = String(o.row.label ?? "Signing fee");
      const what = o.kind === "royalty" ? `${periodLabel(String(o.row.period))} royalty` : label.charAt(0).toLowerCase() + label.slice(1);
      const c = chaseOf(o);
      if (c && (toBool(c.escalated) || toBool(c.promise_broken) || c.status === "DISPUTED")) {
        const state = c.status === "DISPUTED" ? `disputed: ${String(c.dispute_reason ?? "").slice(0, 80)}` : toBool(c.promise_broken) ? `promised for ${day(c.promise_date)}, not paid` : "escalated to the director";
        add({ kind: "Collection", tone: c.status === "DISPUTED" ? "warn" : "bad", title: `${who} ${what} ${daysBetween(o.due!, today)} days late, ${c.status === "DISPUTED" ? "disputed" : toBool(c.promise_broken) ? "promise missed" : "escalated"}`, detail: `₹${Math.round(o.amount).toLocaleString("en-IN")} unpaid, ${state}`, href: "/collections", date: o.due });
        continue;
      }
      add({ kind: o.kind === "royalty" ? "Royalty" : "Fee", tone: "bad", title: `${who} ${what} overdue`, detail: `₹${Math.round(o.amount).toLocaleString("en-IN")} unpaid, ${daysBetween(o.due!, today)} days past due`, href: o.kind === "royalty" ? "/royalties" : "/fees?overdue=true", date: o.due });
    }
    // Audit actions that need someone, one line per store when a store has several.
    const flagged = openActions.filter((a) => a.status === "SUBMITTED" || a.severity === "CRITICAL" || (a.status === "OPEN" && !!a.due_date && day(a.due_date)! < today));
    for (const pid of [...new Set(flagged.map((a) => String(a.project_id)))]) {
      const mine = flagged.filter((a) => String(a.project_id) === pid).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      const overdue = mine.filter((a) => a.status === "OPEN" && !!a.due_date && day(a.due_date)! < today);
      const critical = mine.filter((a) => a.severity === "CRITICAL").length, answered = mine.filter((a) => a.status === "SUBMITTED").length;
      const a = mine[0];
      const tone: Tone = overdue.length ? "bad" : answered === mine.length ? "info" : "warn";
      const detail = mine.length === 1
        ? (a.status === "SUBMITTED" ? "Franchisee answered; review the evidence" : `${critical ? "Critical, " : ""}${overdue.length ? `overdue since ${day(a.due_date)}` : `due ${day(a.due_date)}`}`)
        : [overdue.length && `${overdue.length} overdue since ${day(overdue[0].due_date)}`, critical && `${critical} critical`, answered && `${answered} to review`].filter(Boolean).join(", ");
      add({
        kind: "Audit action", tone,
        title: mine.length === 1 ? `${place(pid).name}: ${String(a.description ?? a.item_code).split(":")[0].slice(0, 80)}` : `${place(pid).name}: ${mine.length} audit actions open`,
        detail, href: `/audits/${a.audit_id}`, date: day(a.due_date),
      });
    }
    for (const l of liveLicences.filter((l) => l.status === "EXPIRED")) add({ kind: "Licence", tone: "bad", title: `${place(l.project_id).name} ${l.name} expired`, detail: `Expired ${day(l.expires_on) ?? ""}`.trim(), href: `/projects/${l.project_id}`, date: day(l.expires_on) });
    for (const l of expiring(30)) add({ kind: "Licence", tone: "warn", title: `${place(l.project_id).name} ${l.name} expires soon`, detail: `Expires ${day(l.expires_on)}`, href: `/projects/${l.project_id}`, date: day(l.expires_on) });
    for (const o of orders) {
      if (!["PLACED", "CONFIRMED"].includes(String(o.status)) || !o.expected_delivery) continue;
      const exp = day(o.expected_delivery)!, need = day(o.needed_by);
      if (!(exp < today || (need && exp > need))) continue;
      add({ kind: "Purchase order", tone: exp < today ? "bad" : "warn", title: `${place(o.project_id).name} ${o.po_number} running late`, detail: exp < today ? `Delivery was expected ${exp}` : `Expected ${exp}, needed by ${need}`, href: `/projects/${o.project_id}`, date: need ?? exp });
    }
    for (const p of auditDue) add({ kind: "Audit", tone: "warn", title: `${place(p.ROWID).name} audit overdue`, detail: "No audit scheduled", href: "/audits", date: null });
    items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || String(a.date ?? "9999").localeCompare(String(b.date ?? "9999")));

    return {
      as_of: call.now.toISOString(), months: q.months, region, region_locked: locked,
      period: { from: cur[0], to: last, label: q.months === 1 ? periodLabel(last) : `${periodLabel(cur[0])} to ${periodLabel(last)}`, previous_label: q.months === 1 ? periodLabel(prev[0]) : `${periodLabel(prev[0])} to ${periodLabel(prev.at(-1)!)}` },
      finance,
      revenue: finance ? {
        ...now, previous: before,
        net_sales_change_pct: change(now.net_sales, before.net_sales), royalty_change_pct: change(now.royalty, before.royalty),
        collection_pct: pct(now.collected, now.royalty), reporting_pct: pct(now.reports, now.due), stores_trading: opened.length, pos: posFeed, series,
      } : {
        net_sales: now.net_sales, reports: now.reports, due: now.due, previous: { net_sales: before.net_sales },
        net_sales_change_pct: change(now.net_sales, before.net_sales), reporting_pct: pct(now.reports, now.due), stores_trading: opened.length, pos: posFeed,
        series: series.map(({ period, label, net_sales }) => ({ period, label, net_sales })),
      },
      receivables: !finance ? null : {
        total: sum(owed, (o) => o.amount), overdue: sum(overdueOwed, (o) => o.amount), fees: sum(owed.filter((o) => o.kind === "fee"), (o) => o.amount), royalty: sum(owed.filter((o) => o.kind === "royalty"), (o) => o.amount), ageing,
        collections: {
          rate_pct: behaviour!.rate_pct, billed_90d: behaviour!.billed, collected_90d: behaviour!.collected, days_to_pay: behaviour!.days_to_pay,
          open: chased.length, escalated: chased.filter((c) => toBool(c.escalated)).length, broken_promises: chased.filter((c) => toBool(c.promise_broken)).length,
          promised: chased.filter((c) => c.status === "PROMISED").length, disputed: chased.filter((c) => c.status === "DISPUTED").length,
        },
      },
      stores, compliance,
      attention: { items, counts: { bad: items.filter((i) => i.tone === "bad").length, warn: items.filter((i) => i.tone === "warn").length, info: items.filter((i) => i.tone === "info").length } },
    };
  });
}
