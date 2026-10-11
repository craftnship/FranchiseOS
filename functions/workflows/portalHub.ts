import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { renewDays } from "./licences";
import { duePeriods, nextPeriod, periodLabel, royaltySettings } from "./royalties";
import { launchFor, launchSettings } from "./launch";

// Franchisee portal v2: one to-do list across every module for all of the franchisee's stores, their
// documents in one place (the brand library plus their own records), and messages with the brand team.

export type TodoLevel = "overdue" | "due" | "soon" | "info";
export interface Todo { key: string; kind: string; level: TodoLevel; title: string; detail?: string; due?: string | null; project_code?: string | null; path: string }

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const addDays = (date: string, days: number) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const ACTIVE = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];
const ORDER: Record<TodoLevel, number> = { overdue: 0, due: 1, soon: 2, info: 3 };

/** Due-date level: past is overdue, within 3 days is due, within the window is soon. */
const levelOf = (due: string | null, today: string, soonDays = 14): TodoLevel | null => {
  if (!due) return "due";
  if (due < today) return "overdue";
  if (due <= addDays(today, 3)) return "due";
  return due <= addDays(today, soonDays) ? "soon" : null;
};

/** Everything the franchisee should act on now, across their stores, most urgent first. */
export async function portalTodo(store: Store, ctx: TenantContext, franchiseeId: string, today: string): Promise<{ items: Todo[]; counts: Record<TodoLevel, number> }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const own = { franchisee_id: franchiseeId };
  const [projects, agreements, apps] = await Promise.all([
    repo.findMany("franchise_projects", own, { limit: 50 }), repo.findMany("agreements", own, { limit: 50 }), repo.findMany("franchise_applications", own, { limit: 50 }),
  ]);
  const items: Todo[] = [];
  const push = (t: Todo) => items.push(t);

  // Agreements: to sign, the signing fee, and a renewal coming up.
  const notice = launchSettings(tenant).renewal_notice_days;
  for (const a of agreements) {
    if (["SENT", "VIEWED"].includes(String(a.status))) push({ key: `agr-sign:${a.ROWID}`, kind: "agreement", level: "due", title: `Sign your franchise agreement ${a.agreement_code}`, detail: "Check your email for the Zoho Sign request.", path: "/portal/agreement" });
    if (a.status === "SIGNED" && a.fee_status && !["PAID", "VOID"].includes(String(a.fee_status)) && toNum(a.fee_balance) > 0) {
      const due = day(a.fee_due_date);
      push({ key: `agr-fee:${a.ROWID}`, kind: "payment", level: levelOf(due, today, 3650)!, title: `Pay the franchise fee: ${inr(toNum(a.fee_balance))}`, detail: `Invoice on ${a.agreement_code}.`, due, path: "/portal/funding" });
    }
    if (a.status === "SIGNED" && a.expiry_date && !["RENEWED", "NOT_RENEWING"].includes(String(a.renewal_status ?? "")) && day(a.expiry_date)! <= addDays(today, notice)) {
      push({ key: `agr-renew:${a.ROWID}`, kind: "renewal", level: "info", title: `${a.agreement_code} ends ${day(a.expiry_date)}`, detail: a.renewal_status ? `Renewal: ${String(a.renewal_status).toLowerCase().replace(/_/g, " ")}.` : "Talk to your franchise manager about renewing.", due: day(a.expiry_date), path: "/portal/agreement" });
    }
  }
  // An application still with the franchisee (before there is a store).
  if (!projects.length) {
    const app = apps.find((a) => ["DRAFT", "SITE_REQUIRED"].includes(String(a.status)));
    if (app) push({ key: `app:${app.ROWID}`, kind: "application", level: "due", title: app.status === "DRAFT" ? "Complete and submit your application" : "Propose a site for your store", path: app.status === "DRAFT" ? "/portal/application" : "/portal/site" });
  }

  const { report_due_day } = royaltySettings(tenant);
  for (const p of projects) {
    if (p.status === "CLOSED") continue;
    const pid = String(p.ROWID), code = String(p.project_code);
    const where = { project_id: pid };
    const [tasks, licences, reports, instalments, actions, snags, designs, training, orders] = await Promise.all([
      ACTIVE.includes(String(p.status)) ? repo.findMany("opening_checklists", where, { limit: 300 }) : Promise.resolve([] as Row[]),
      repo.findMany("licences", where, { limit: 50 }), repo.findMany("sales_reports", where, { limit: 300 }), repo.findMany("fee_instalments", where, { limit: 50 }),
      repo.findMany("corrective_actions", where, { limit: 300 }), repo.findMany("snags", where, { limit: 300 }), repo.findMany("design_reviews", where, { limit: 50 }),
      repo.findMany("staff_training", where, { limit: 500 }), repo.findMany("purchase_orders", where, { limit: 300 }),
    ]);

    // Opening tasks blocked, overdue or due within the week.
    for (const t of tasks.filter((x) => x.status !== "COMPLETED")) {
      const due = day(t.due_date), lvl = t.status === "BLOCKED" ? "overdue" : levelOf(due, today, 7);
      if (lvl) push({ key: `task:${t.ROWID}`, kind: "opening", level: lvl, title: t.status === "BLOCKED" ? `Unblock: ${t.item}` : String(t.item), detail: toBool(t.mandatory) ? "Mandatory opening task." : undefined, due, project_code: code, path: "/portal/tasks" });
    }
    // Licences: mandatory ones missing before opening, and renewals coming up.
    for (const l of licences) {
      if (ACTIVE.includes(String(p.status)) && toBool(l.mandatory) && l.status !== "ISSUED") {
        const target = day(p.target_opening_date);
        push({ key: `lic:${l.ROWID}`, kind: "licence", level: target && target <= addDays(today, 30) ? "due" : "soon", title: `${l.status === "APPLIED" ? "Chase" : "Apply for"} the ${l.name}`, detail: `Needed before the store opens${target ? ` on ${target}` : ""}.`, project_code: code, path: "/portal/tasks" });
      }
      if (l.status === "ISSUED" && l.expires_on) {
        const exp = day(l.expires_on)!;
        if (exp <= addDays(today, renewDays(tenant, String(l.licence_code)))) push({ key: `lic-renew:${l.ROWID}`, kind: "licence", level: exp < addDays(today, 14) ? "due" : "soon", title: `Renew the ${l.name}`, detail: `It expires ${exp}.`, due: exp, project_code: code, path: "/portal/tasks" });
      }
    }
    // Monthly sales: missing or sent back; royalty invoices unpaid.
    const byPeriod = new Map(reports.map((r) => [String(r.period), r]));
    for (const period of duePeriods(p, today).slice(-6)) {
      const r = byPeriod.get(period);
      if (r && r.status !== "RETURNED") continue;
      const due = `${nextPeriod(period)}-${String(report_due_day).padStart(2, "0")}`;
      push({ key: `sales:${pid}:${period}`, kind: "sales", level: levelOf(due, today, 31)!, title: r ? `Fix your ${periodLabel(period)} sales report` : `Report your ${periodLabel(period)} sales`, detail: r?.review_note ? `Sent back: ${r.review_note}` : "Your royalty invoice is raised from it.", due, project_code: code, path: "/portal/sales" });
    }
    for (const r of reports.filter((x) => x.status === "INVOICED" && toNum(x.invoice_balance) > 0)) {
      const due = day(r.invoice_due_date);
      push({ key: `roy:${r.ROWID}`, kind: "payment", level: levelOf(due, today, 3650)!, title: `Pay royalty ${r.invoice_number ?? ""}: ${inr(toNum(r.invoice_balance))}`.replace("  ", " "), detail: `For ${periodLabel(String(r.period))}.`, due, project_code: code, path: "/portal/sales" });
    }
    // Fee instalments invoiced and unpaid (the signing invoice is the agreement's, above).
    for (const f of instalments.filter((x) => x.status === "INVOICED" && toNum(x.invoice_balance) > 0 && String(x.zoho_books_invoice_id ?? "") !== String(agreements.find((a) => String(a.ROWID) === String(x.agreement_id))?.zoho_books_invoice_id ?? "-"))) {
      const due = day(f.invoice_due_date);
      push({ key: `fee:${f.ROWID}`, kind: "payment", level: levelOf(due, today, 3650)!, title: `Pay ${f.kind === "DEPOSIT" ? "the security deposit" : `fee instalment “${f.label}”`}: ${inr(toNum(f.invoice_balance))}`, detail: f.invoice_number ? `Invoice ${f.invoice_number}.` : undefined, due, project_code: code, path: "/portal/funding" });
    }
    // Corrective actions from audits.
    for (const a of actions.filter((x) => x.status === "OPEN")) {
      const due = day(a.due_date);
      push({ key: `action:${a.ROWID}`, kind: "audit", level: levelOf(due, today, 3650)!, title: `Fix: ${String(a.description).slice(0, 140)}`, detail: a.review_note ? `Sent back: ${a.review_note}` : a.severity === "CRITICAL" ? "Critical: a food-safety or legal standard." : undefined, due, project_code: code, path: "/portal/audits" });
    }
    // Construction: open snags, and a design sent back.
    for (const s of snags.filter((x) => x.status === "OPEN")) {
      const due = day(s.due_date);
      push({ key: `snag:${s.ROWID}`, kind: "construction", level: levelOf(due, today, 3650)!, title: `Fix snag ${s.snag_no}: ${s.title}`, detail: s.area ? String(s.area) : undefined, due, project_code: code, path: "/portal/construction" });
    }
    const latestDesign = designs.sort((a, b) => toNum(b.version) - toNum(a.version))[0];
    if (latestDesign?.status === "CHANGES_REQUESTED") push({ key: `design:${latestDesign.ROWID}`, kind: "construction", level: "due", title: `Revise your store design (version ${latestDesign.version})`, detail: latestDesign.review_note ? String(latestDesign.review_note) : undefined, project_code: code, path: "/portal/construction" });
    // Training sent back.
    for (const t of training.filter((x) => x.status === "RETURNED")) push({ key: `training:${t.ROWID}`, kind: "team", level: "due", title: `Redo a training record`, detail: t.review_note ? `Sent back: ${t.review_note}` : undefined, project_code: code, path: "/portal/team" });
    // Orders due in: record the delivery.
    for (const o of orders.filter((x) => x.status === "CONFIRMED" && x.expected_delivery && day(x.expected_delivery)! <= today)) push({ key: `po:${o.ROWID}`, kind: "orders", level: day(o.expected_delivery)! < addDays(today, -2) ? "overdue" : "due", title: `Record the delivery of ${o.po_number}`, detail: `Due ${day(o.expected_delivery)}.`, due: day(o.expected_delivery), project_code: code, path: "/portal/orders" });

    // Opening day: the franchisee's launch tasks and weekly sales.
    if (p.grand_opening_date || p.status === "OPENED") {
      const launch = await launchFor(store, ctx, p, today);
      for (const t of (launch.tasks as Row[]).filter((x) => x.status === "OPEN" && x.owner_side === "FRANCHISEE")) {
        const due = day(t.due_date), lvl = levelOf(due, today, 14);
        if (lvl) push({ key: `launch:${t.ROWID}`, kind: "launch", level: lvl, title: String(t.item), detail: "Grand-opening plan.", due, project_code: code, path: "/portal/launch" });
      }
      for (const w of (launch.weeks as Row[]).filter((x) => x.finished && x.net_sales == null)) push({ key: `week:${pid}:${w.week_no}`, kind: "sales", level: day(w.week_end)! < addDays(today, -3) ? "overdue" : "due", title: `Report week ${w.week_no} sales`, detail: `${w.week_start} to ${w.week_end}.`, due: day(w.week_end), project_code: code, path: "/portal/launch" });
    }
  }

  // Unread messages from the brand team.
  const unread = (await repo.findMany("messages", { franchisee_id: franchiseeId, from_side: "BRAND" }, { limit: 500 })).filter((m) => !m.read_at);
  if (unread.length) push({ key: "messages", kind: "message", level: "due", title: `${unread.length} new message${unread.length === 1 ? "" : "s"} from the brand team`, path: "/portal/messages" });

  items.sort((a, b) => ORDER[a.level] - ORDER[b.level] || String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
  const counts = { overdue: 0, due: 0, soon: 0, info: 0 } as Record<TodoLevel, number>;
  for (const i of items) counts[i.level]++;
  return { items, counts };
}

// ── Documents ─────────────────────────────────────────────────────────────────────────────────────

export const DOC_CATEGORIES = ["MANUAL", "MARKETING", "TRAINING", "POLICY", "FORM", "OTHER"] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

/** Brand documents shared with everyone or with one franchisee. */
export async function brandDocuments(repo: TenantRepo, franchiseeId: string | null): Promise<Row[]> {
  const rows = (await repo.findMany("brand_documents", { status: "ACTIVE" }, { limit: 500 })).filter((d) => !franchiseeId || !d.franchisee_id || String(d.franchisee_id) === franchiseeId);
  return rows.sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title)));
}

export async function shareDocument(store: Store, ctx: TenantContext, input: { title: string; category: DocCategory; notes?: string | null; franchisee_id?: string | null; file_ref: string }, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (input.franchisee_id && !(await repo.findOne("franchisees", { ROWID: input.franchisee_id }))) throw new AppError("VALIDATION_FAILED", "Choose a franchisee.", { franchisee_id: "not found" });
  const row = await repo.insert("brand_documents", { title: input.title, category: input.category, notes: input.notes ?? null, franchisee_id: input.franchisee_id ?? null, file_ref: input.file_ref, status: "ACTIVE", uploaded_by: ctx.userId, uploaded_at: now.toISOString() });
  await logActivity(store, ctx, { entityType: "document", entityId: String(row.ROWID), action: "document:shared", metadata: { title: input.title, category: input.category, franchisee_id: input.franchisee_id ?? null } });
  return row;
}

/**
 * The franchisee's own records that have a file, each with the route that serves it (those routes
 * check ownership themselves).
 */
export async function ownRecords(repo: TenantRepo, franchiseeId: string): Promise<Row[]> {
  const out: Row[] = [];
  const projects = await repo.findMany("franchise_projects", { franchisee_id: franchiseeId }, { limit: 50 });
  for (const p of projects) {
    const pid = String(p.ROWID), code = String(p.project_code), where = { project_id: pid };
    const [licences, reports, plans, designs, orders, training, site] = await Promise.all([
      repo.findMany("licences", where, { limit: 50 }), repo.findMany("sales_reports", where, { limit: 300 }), repo.findMany("funding_plans", where, { limit: 5 }),
      repo.findMany("design_reviews", where, { limit: 50 }), repo.findMany("purchase_orders", where, { limit: 300 }), repo.findMany("staff_training", where, { limit: 500 }),
      p.site_id ? repo.findOne("sites", { ROWID: String(p.site_id) }) : Promise.resolve(null),
    ]);
    const add = (group: string, title: string, date: unknown, path: string) => out.push({ group, title, date: day(date), project_code: code, path });
    for (const l of licences.filter((x) => x.file_ref)) add("Licences", String(l.name), l.issued_on, `/projects/${pid}/licences/${l.ROWID}/certificate`);
    if (site) { const lease = await repo.findOne("leases", { site_id: String(site.ROWID) }); if (lease?.file_ref) add("Lease and funding", "Lease agreement", lease.signed_on ?? lease.lease_start, `/sites/${site.ROWID}/lease/document`); }
    for (const f of plans.filter((x) => x.sanction_ref)) add("Lease and funding", `Loan sanction letter${f.lender ? `, ${f.lender}` : ""}`, f.sanctioned_on, `/projects/${pid}/funding/sanction-letter`);
    for (const d of designs.filter((x) => x.file_ref)) add("Store design", `${d.title ?? "Design"} (version ${d.version})`, d.submitted_at, `/projects/${pid}/designs/${d.ROWID}/file`);
    for (const r of reports.filter((x) => x.file_ref)) add("Sales reports", `Sales report, ${periodLabel(String(r.period))}`, r.submitted_at, `/projects/${pid}/sales/${r.ROWID}/file`);
    for (const o of orders.filter((x) => x.delivery_ref)) add("Orders", `Delivery note, ${o.po_number}`, o.delivered_on, `/projects/${pid}/purchase-orders/${o.ROWID}/delivery-note`);
    for (const t of training.filter((x) => x.certificate_ref)) add("Training certificates", `${t.module_code} certificate`, t.completed_on, `/projects/${pid}/training/${t.ROWID}/certificate`);
  }
  return out.sort((a, b) => String(a.group).localeCompare(String(b.group)) || String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────────

export type Side = "FRANCHISEE" | "BRAND";

/** One franchisee's conversation with the brand team, oldest first. Reading marks the other side's messages read. */
export async function conversation(store: Store, ctx: TenantContext, franchiseeId: string, reader: Side, now: Date): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const rows = (await repo.findMany("messages", { franchisee_id: franchiseeId }, { limit: 1000 })).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)) || String(a.ROWID).localeCompare(String(b.ROWID), undefined, { numeric: true }));
  const at = now.toISOString();
  for (const m of rows) if (m.from_side !== reader && !m.read_at) { await repo.update("messages", String(m.ROWID), { read_at: at }); m.read_at = at; }
  const people = new Map<string, string>();
  for (const id of new Set(rows.map((m) => String(m.sender_user_id ?? "")).filter(Boolean))) {
    const u = await repo.findOne("users", { ROWID: id });
    if (u) people.set(id, String(u.name ?? u.email));
  }
  return rows.map((m) => ({ ...m, sender: people.get(String(m.sender_user_id)) ?? null }));
}

export async function sendMessage(store: Store, ctx: TenantContext, franchiseeId: string, from: Side, input: { text: string; project_id?: string | null; attachment_ref?: string | null }, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const franchisee = await repo.findOne("franchisees", { ROWID: franchiseeId });
  if (!franchisee) throw new AppError("NOT_FOUND");
  if (input.project_id) {
    const p = await repo.findOne("franchise_projects", { ROWID: input.project_id });
    if (!p || String(p.franchisee_id) !== franchiseeId) throw new AppError("VALIDATION_FAILED", "That store isn't this franchisee's.", { project_id: "not theirs" });
  }
  const row = await repo.insert("messages", { franchisee_id: franchiseeId, project_id: input.project_id ?? null, from_side: from, sender_user_id: ctx.userId, message_text: input.text, attachment_ref: input.attachment_ref ?? null, sent_at: now.toISOString(), read_at: null });
  await logActivity(store, ctx, { entityType: "franchisee", entityId: franchiseeId, action: from === "FRANCHISEE" ? "message:from_franchisee" : "message:from_brand", metadata: { message_id: String(row.ROWID), preview: input.text.slice(0, 140) } });
  return row;
}

/** Staff inbox: every conversation, newest first, with what's unread from franchisees. */
export async function inbox(store: Store, ctx: TenantContext): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const [messages, franchisees] = await Promise.all([repo.findMany("messages", {}, { limit: 5000 }), repo.findMany("franchisees", {}, { limit: 1000 })]);
  const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
  const by = new Map<string, Row[]>();
  for (const m of messages) by.set(String(m.franchisee_id), [...(by.get(String(m.franchisee_id)) ?? []), m]);
  return [...by.entries()].map(([fid, ms]) => {
    const last = ms.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
    const f = fmap.get(fid);
    return { franchisee_id: fid, franchisee: f ? f.display_name ?? f.franchise_code : fid, franchise_code: f?.franchise_code ?? null, last_at: last.sent_at, last_from: last.from_side, preview: String(last.message_text).slice(0, 160), unread: ms.filter((m) => m.from_side === "FRANCHISEE" && !m.read_at).length, total: ms.length };
  }).sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}
