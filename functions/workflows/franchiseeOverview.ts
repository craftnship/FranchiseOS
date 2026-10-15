import { TenantContext } from "../common/context";
import { Row, Store, TenantRepo } from "../common/store";
import { round, toNum } from "../common/values";
import { OPEN_COLLECTION } from "./collections";
import { leaseForSite } from "./leases";
import { brandDocuments, portalLogins, portalTodo, Todo } from "./portalHub";
import { periodLabel, periodOf, prevPeriod, royaltyLedger } from "./royalties";

// One franchise partner, everything about them on one screen (the Franchisees record page). A partner
// is the durable entity; applications, agreements and stores are events in its life, so this reads
// across every table that carries franchisee_id and sums the stores a multi-unit partner owns.

const TRADING = ["OPENED"];
const OPENING = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];
const APP_CLOSED = ["REJECTED", "WITHDRAWN", "ACTIVE"];
const OPEN_ACTION = ["OPEN", "SUBMITTED"];
const BAND_RANK: Record<string, number> = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 };
const LICENCE_SOON_DAYS = 60;

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const addDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const sum = (rows: Row[], k: string) => round(rows.reduce((a, r) => a + toNum(r[k]), 0), 2);
const byTime = (a: Row, b: Row) => String(b.CREATEDTIME ?? "").localeCompare(String(a.CREATEDTIME ?? ""));

export interface OverviewOptions { today: string; finance: boolean; portal: boolean }

/** Everything the record page shows, in one call. Money is included only when `finance` is set. */
export async function franchiseeOverview(store: Store, ctx: TenantContext, franchisee: Row, opts: OverviewOptions): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const fid = String(franchisee.ROWID);
  const own = { franchisee_id: fid };
  const [applications, sites, agreements, projects, audits, actions, licences, instalments, collections, logins, shared] = await Promise.all([
    repo.findMany("franchise_applications", own, { orderBy: "CREATEDTIME", desc: true, limit: 100 }),
    repo.findMany("sites", own, { orderBy: "CREATEDTIME", desc: true, limit: 100 }),
    repo.findMany("agreements", own, { orderBy: "CREATEDTIME", desc: true, limit: 100 }),
    repo.findMany("franchise_projects", own, { orderBy: "CREATEDTIME", desc: true, limit: 100 }),
    repo.findMany("audits", own, { orderBy: "CREATEDTIME", desc: true, limit: 100 }),
    repo.findMany("corrective_actions", own, { orderBy: "due_date", limit: 300 }),
    repo.findMany("licences", own, { orderBy: "expires_on", limit: 300 }),
    opts.finance ? repo.findMany("fee_instalments", own, { orderBy: "seq", limit: 300 }) : Promise.resolve([] as Row[]),
    opts.finance ? repo.findMany("collections", own, { orderBy: "due_date", limit: 300 }) : Promise.resolve([] as Row[]),
    portalLogins(repo, fid),
    brandDocuments(repo, fid),
  ]);
  const projectCode = new Map(projects.map((p) => [String(p.ROWID), String(p.project_code)]));
  const withStore = (r: Row) => ({ ...r, project_code: projectCode.get(String(r.project_id)) ?? null });

  // Stores: trading ones carry health and the sales feed; opening ones carry readiness.
  const stores = projects.map((p) => ({
    ROWID: p.ROWID, project_code: p.project_code, status: p.status, site_id: p.site_id, application_id: p.application_id,
    target_opening_date: day(p.target_opening_date), actual_opening_date: day(p.actual_opening_date),
    readiness_score: p.readiness_score ?? null, readiness_rag: p.readiness_rag ?? null, risk_level: p.risk_level ?? null,
    health_score: p.health_score ?? null, health_band: p.health_band ?? null, health_updated_on: day(p.health_updated_on),
    pos_status: p.pos_status ?? "NONE", pos_last_day: day(p.pos_last_day), zoho_project_id: p.zoho_project_id ?? null,
    city: sites.find((s) => String(s.ROWID) === String(p.site_id))?.city ?? null,
  }));
  const trading = projects.filter((p) => TRADING.includes(String(p.status)));

  // Sales and royalties: each trading store's ledger, flattened to one row per store-month.
  const ledgers = await Promise.all(trading.map(async (p) => ({ project: p, ledger: await royaltyLedger(store, ctx, p, opts.today) })));
  const months: Row[] = [];
  for (const { project, ledger } of ledgers) {
    for (const m of ledger.months as Row[]) {
      const r = (m.report as Row | null) ?? null;
      months.push({
        project_id: String(project.ROWID), project_code: project.project_code, period: m.period, label: m.label, due_on: m.due_on, late: m.late,
        pos_net_sales: (m.pos as Row | null)?.net_sales ?? r?.pos_net_sales ?? null, reported_net_sales: r ? (r.basis === "POS" ? r.reported_net_sales ?? null : r.net_sales) : null,
        net_sales: r?.net_sales ?? null, variance_pct: m.variance_pct, strayed: m.strayed, basis: r?.basis ?? null,
        status: r?.status ?? (m.late ? "LATE" : "DUE"), royalty_amount: r?.royalty_amount ?? null, marketing_amount: r?.marketing_amount ?? null,
        invoice_number: r?.invoice_number ?? null, zoho_books_invoice_id: r?.zoho_books_invoice_id ?? null, invoice_balance: r?.invoice_balance ?? null, invoice_due_date: day(r?.invoice_due_date),
        report_id: r?.ROWID ?? null,
      });
    }
  }
  months.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(a.project_code).localeCompare(String(b.project_code)));
  const thisMonth = periodOf(opts.today);
  const lastMonth = prevPeriod(thisMonth);
  const last3 = [lastMonth, prevPeriod(lastMonth), prevPeriod(prevPeriod(lastMonth))];
  const netOf = (m: Row) => toNum(m.pos_net_sales ?? m.net_sales);
  const monthTotal = (p: string) => round(months.filter((m) => m.period === p).reduce((a, m) => a + netOf(m), 0), 2);
  const billed = (m: Row) => m.status === "INVOICED" || m.status === "PAID";
  const sales = {
    month_to_date: round(ledgers.reduce((a, l) => a + toNum(((l.ledger.feed as Row).month_to_date as Row | null)?.net_sales), 0), 2),
    last_month: { period: lastMonth, label: periodLabel(lastMonth), net_sales: monthTotal(lastMonth) },
    three_months: round(last3.reduce((a, p) => a + monthTotal(p), 0), 2),
    by_month: last3.map((p) => ({ period: p, label: periodLabel(p), net_sales: monthTotal(p) })).reverse(),
    feed: trading.length ? (stores.filter((s) => TRADING.includes(String(s.status))).every((s) => s.pos_status === "CONNECTED") ? "CONNECTED" : stores.some((s) => s.pos_status === "STALE") ? "STALE" : "NONE") : "NONE",
  };
  const royalty = {
    billed_three_months: round(months.filter((m) => billed(m) && last3.includes(String(m.period))).reduce((a, m) => a + toNum(m.royalty_amount) + toNum(m.marketing_amount), 0), 2),
    waiting: months.filter((m) => m.status === "SUBMITTED").length,
    missing: months.filter((m) => m.status === "LATE" || m.status === "RETURNED").length,
    strayed: months.filter((m) => m.strayed).length,
    rates: ledgers[0]?.ledger.rates ?? null,
  };

  // Money (finance only): what is owed now, from the collections ledger, plus fees and instalments.
  const openCollections = collections.filter((c) => OPEN_COLLECTION.includes(String(c.status)));
  const overdue = openCollections.filter((c) => c.due_date && String(c.due_date).slice(0, 10) < opts.today);
  const oldest = overdue.reduce((a, c) => Math.max(a, daysBetween(String(c.due_date).slice(0, 10), opts.today)), 0);
  const money = opts.finance ? {
    outstanding: { total: sum(openCollections, "amount"), overdue: sum(overdue, "amount"), count: openCollections.length, overdue_count: overdue.length, oldest_days: oldest },
    collections: openCollections.map(withStore),
    instalments: instalments.map(withStore),
    fees: agreements.map((g) => ({ ROWID: g.ROWID, agreement_code: g.agreement_code, fee_status: g.fee_status ?? null, fee_total: g.fee_total ?? null, fee_balance: g.fee_balance ?? null, fee_due_date: day(g.fee_due_date), fee_paid_on: day(g.fee_paid_on), zoho_books_invoice_id: g.zoho_books_invoice_id ?? null })),
    paid_royalty: sum(months.filter((m) => m.status === "PAID"), "royalty_amount"),
  } : null;

  // Compliance: audits, the actions still open, licences about to lapse, and each site's lease.
  const openActions = actions.filter((a) => OPEN_ACTION.includes(String(a.status))).map((a) => ({ ...withStore(a), overdue: a.status === "OPEN" && !!a.due_date && String(a.due_date).slice(0, 10) < opts.today }));
  const soon = addDays(opts.today, LICENCE_SOON_DAYS);
  const lapsing = licences.filter((l) => l.expires_on && String(l.expires_on).slice(0, 10) <= soon && !["NOT_REQUIRED"].includes(String(l.status)));
  const done = audits.filter((a) => a.status === "COMPLETED").sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")));
  const leases: Row[] = [];
  for (const s of sites) { const l = await leaseForSite(store, ctx, String(s.ROWID)); if (l) leases.push({ ...l, site_code: s.site_code, city: s.city }); }
  const compliance = {
    audits: audits.map(withStore), open_actions: openActions, licences: licences.map(withStore), lapsing: lapsing.map(withStore), leases,
    last_audit: done[0] ? { ROWID: done[0].ROWID, audit_code: done[0].audit_code, score: done[0].score, rating: done[0].rating, completed_at: done[0].completed_at, project_code: projectCode.get(String(done[0].project_id)) ?? null } : null,
  };

  // Health across the stores: the worst band leads, because one struggling store is the partner's problem.
  const scored = stores.filter((s) => s.health_band);
  const health = {
    worst_band: scored.length ? scored.reduce((w, s) => (BAND_RANK[String(s.health_band)] < BAND_RANK[w] ? String(s.health_band) : w), "HEALTHY") : null,
    average_score: scored.length ? round(scored.reduce((a, s) => a + toNum(s.health_score), 0) / scored.length, 0) : null,
    scored: scored.length,
  };

  // What needs attention: the partner's own to-do list (payments owed stay with finance), plus what the brand is sitting on.
  const todo = await portalTodo(store, ctx, fid, opts.today);
  const attention: Todo[] = todo.items.filter((t) => opts.finance || t.kind !== "payment");
  for (const m of months.filter((x) => x.status === "SUBMITTED")) {
    attention.push({ key: `review:${m.report_id}`, kind: "royalty.review", level: m.strayed ? "due" : "info", title: `${m.label} sales report waits for finance`, detail: m.strayed ? `Reported ${toNum(m.variance_pct) > 0 ? "above" : "below"} POS by ${Math.abs(toNum(m.variance_pct))}%` : undefined, project_code: String(m.project_code), path: "/royalties" });
  }
  const order: Record<string, number> = { overdue: 0, due: 1, soon: 2, info: 3 };
  attention.sort((a, b) => order[a.level] - order[b.level] || String(a.due ?? "9").localeCompare(String(b.due ?? "9")));

  // Documents: the application KYC files and what the brand has shared with this partner.
  const appDocs = (await Promise.all(applications.map((a) => repo.findMany("application_documents", { application_id: String(a.ROWID) }, { limit: 50 })))).flat()
    .map((d) => ({ ...d, application_code: applications.find((a) => String(a.ROWID) === String(d.application_id))?.application_code ?? null }));

  const openApps = applications.filter((a) => !APP_CLOSED.includes(String(a.status)) && !projects.some((p) => String(p.application_id) === String(a.ROWID)));
  return {
    franchisee: { ...franchisee, portal_users: logins.length, since: day(agreements.filter((g) => g.signed_at).sort((a, b) => String(a.signed_at).localeCompare(String(b.signed_at)))[0]?.signed_at) ?? day(franchisee.CREATEDTIME) },
    finance: opts.finance,
    kpis: {
      stores: { trading: trading.length, opening: projects.filter((p) => OPENING.includes(String(p.status))).length, pipeline: openApps.length },
      sales, royalty, health,
      outstanding: money?.outstanding ?? null,
      compliance: { last_audit: compliance.last_audit, open_actions: openActions.length, lapsing_licences: lapsing.length, agreement_expiry: day(agreements.filter((g) => g.status === "SIGNED").map((g) => g.expiry_date).filter(Boolean).sort()[0]) },
    },
    attention: attention.slice(0, 20),
    stores,
    applications: applications.sort(byTime),
    sites: sites.map((s) => ({ ROWID: s.ROWID, site_code: s.site_code, status: s.status, city: s.city, state: s.state, site_score: s.site_score ?? null, application_id: s.application_id })),
    agreements: agreements.map((g) => ({
      ROWID: g.ROWID, agreement_code: g.agreement_code, status: g.status, application_id: g.application_id, effective_date: day(g.effective_date), expiry_date: day(g.expiry_date), signed_at: g.signed_at ?? null,
      renewal_status: g.renewal_status ?? null, renewed_until: day(g.renewed_until), zoho_sign_request_id: g.zoho_sign_request_id ?? null, has_document: !!g.document_ref,
      ...(opts.finance ? { fee_status: g.fee_status ?? null, fee_total: g.fee_total ?? null, fee_balance: g.fee_balance ?? null } : {}),
    })),
    royalties: { months, totals: { invoiced_net_sales: sum(months.filter(billed), "net_sales"), royalty: sum(months.filter(billed), "royalty_amount"), marketing: sum(months.filter(billed), "marketing_amount"), outstanding: opts.finance ? sum(months.filter((m) => m.status === "INVOICED"), "invoice_balance") : null } },
    money,
    compliance,
    documents: { application: appDocs, shared },
    activity: await activityFor(repo, { franchisee: [fid], application: applications.map((a) => String(a.ROWID)), agreement: agreements.map((g) => String(g.ROWID)), project: projects.map((p) => String(p.ROWID)), site: sites.map((s) => String(s.ROWID)) }, projectCode),
  };
}

/** The latest activity across the partner and everything that belongs to them, newest first. */
async function activityFor(repo: TenantRepo, ids: Record<string, string[]>, projectCode: Map<string, string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [entity_type, list] of Object.entries(ids)) {
    for (const entity_id of list.slice(0, 10)) rows.push(...await repo.findMany("activity_logs", { entity_type, entity_id }, { orderBy: "CREATEDTIME", desc: true, limit: 15 }));
  }
  const users = new Map((await repo.findMany("users", {}, { limit: 300 })).map((u) => [String(u.ROWID), u]));
  return rows.sort((a, b) => String(b.created_at ?? b.CREATEDTIME).localeCompare(String(a.created_at ?? a.CREATEDTIME))).slice(0, 40).map((a) => {
    let meta: Row = {};
    try { meta = JSON.parse(String(a.metadata_json || "{}")) as Row; } catch { meta = {}; }
    const actor = users.get(String(a.actor_user_id));
    return { id: a.ROWID, at: a.created_at ?? a.CREATEDTIME, action: a.action, entity_type: a.entity_type, entity_id: a.entity_id, project_code: a.entity_type === "project" ? projectCode.get(String(a.entity_id)) ?? null : null, actor: actor ? actor.name ?? actor.email : a.actor_user_id ? "Someone" : "System", details: meta };
  });
}
