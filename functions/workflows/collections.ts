import { logActivity } from "../common/audit";
import { TenantContext } from "../common/context";
import { AppError } from "../common/errors";
import { log } from "../common/logger";
import { Row, Store, TenantRepo } from "../common/store";
import { round, toBool, toNum } from "../common/values";
import { ZohoBooksClient } from "../integrations/clients";
import { refreshFee } from "./fees";
import { refreshInstalment } from "./funding";
import { deliver, portalUsers } from "./notifications";
import { daysBetween, daysLate, owedRows, projectOfOwed } from "./receivables";
import { periodLabel, refreshReport } from "./royalties";

// Collections (docs/collections.md): every unpaid fee, instalment and royalty invoice is chased on a
// ladder the tenant sets, finance works the overdue ones from one list (promises, notes, disputes),
// and a payment typed in by finance is recorded in Books so the invoice closes the same way a
// gateway payment would. Phase 1 needs only the brand's Books; Pay now and autopay wait for Zoho Payments.

export type CollectionKind = "FEE" | "INSTALMENT" | "ROYALTY";
export type CollectionStatus = "OPEN" | "PROMISED" | "DISPUTED" | "PAID" | "CLOSED";

/** One rung of the ladder: how many days from the due date (negative = before), and who hears. */
export interface LadderStep { days: number; franchisee: boolean; roles: string[]; flag: boolean }
export interface CollectionsSettings { ladder: LadderStep[] }

export const DEFAULT_LADDER: LadderStep[] = [
  { days: -3, franchisee: true, roles: [], flag: false },
  { days: 0, franchisee: true, roles: [], flag: false },
  { days: 7, franchisee: true, roles: ["FRANCHISE_MANAGER"], flag: false },
  { days: 15, franchisee: true, roles: ["FINANCE_MANAGER"], flag: false },
  { days: 30, franchisee: false, roles: ["FRANCHISE_DIRECTOR", "FINANCE_MANAGER"], flag: true },
];
export const LADDER_ROLES = ["FRANCHISE_MANAGER", "FINANCE_MANAGER", "FRANCHISE_DIRECTOR", "REGIONAL_MANAGER", "OPERATIONS_MANAGER"];

export function collectionsSettings(tenant: Row | null): CollectionsSettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const c = (s.collections ?? {}) as Record<string, unknown>;
  const ladder = Array.isArray(c.ladder) ? normaliseLadder(c.ladder as unknown[]) : DEFAULT_LADDER;
  return { ladder: ladder.length ? ladder : DEFAULT_LADDER };
}

/** Steps sorted by day, each with a franchisee or at least one role, days within a year either way. */
export function normaliseLadder(steps: unknown[]): LadderStep[] {
  const out: LadderStep[] = [];
  for (const raw of steps) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const days = Math.max(-365, Math.min(365, Math.round(toNum(x.days))));
    const roles = (Array.isArray(x.roles) ? x.roles : []).map(String).filter((r) => LADDER_ROLES.includes(r));
    const franchisee = toBool(x.franchisee);
    if (!franchisee && !roles.length) continue;
    if (out.some((o) => o.days === days)) continue;
    out.push({ days, franchisee, roles, flag: toBool(x.flag) });
  }
  return out.sort((a, b) => a.days - b.days);
}

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const nice = (d: unknown) => {
  const t = Date.parse(String(d).length === 10 ? `${d}T00:00:00Z` : String(d));
  return Number.isNaN(t) ? String(d ?? "") : new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

export const OPEN_COLLECTION = ["OPEN", "PROMISED", "DISPUTED"];

/** The three source tables, read once, with the open items the receivables logic ages. */
export async function collectionSources(repo: TenantRepo) {
  const [agreements, instalments, reports, projects] = await Promise.all([
    repo.findMany("agreements", { status: "SIGNED" }, { orderBy: "ROWID", limit: 10_000 }),
    repo.findMany("fee_instalments", {}, { orderBy: "ROWID", limit: 10_000 }),
    repo.findMany("sales_reports", {}, { orderBy: "ROWID", limit: 10_000 }),
    repo.findMany("franchise_projects", {}, { orderBy: "ROWID", limit: 10_000 }),
  ]);
  return { agreements, instalments, reports, projects, owed: owedRows(agreements, instalments, reports), projectOf: projectOfOwed(projects) };
}

type Sources = Awaited<ReturnType<typeof collectionSources>>;

const kindOf = (o: { kind: string; row: Row }): CollectionKind => (o.kind === "royalty" ? "ROYALTY" : o.row.agreement_code ? "FEE" : "INSTALMENT");
const keyOf = (kind: CollectionKind, sourceId: unknown) => `${kind}:${sourceId}`;

/** What the invoice is for, in the words the franchisee uses. */
export function describeCollection(c: Row): string {
  if (c.kind === "ROYALTY") return `${periodLabel(String(c.period ?? ""))} royalty`;
  if (c.kind === "FEE") return "the franchise fee";
  return c.label ? String(c.label).charAt(0).toLowerCase() + String(c.label).slice(1) : "a fee instalment";
}

/**
 * One collection row per unpaid invoice, kept in step with the sources: new invoices get a row, balances
 * and due dates follow Books, and a row whose invoice is no longer owed closes as PAID (with the day it
 * was paid and how long that took) or CLOSED when the invoice was voided or waived.
 */
export async function syncCollections(store: Store, ctx: Pick<TenantContext, "tenantId">, today: string, src?: Sources): Promise<{ open: Row[]; paid: number; closed: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = src ?? await collectionSources(repo);
  const existing = new Map<string, Row>();
  for (const status of OPEN_COLLECTION) for (const r of await repo.findMany("collections", { status }, { orderBy: "ROWID", limit: 10_000 })) existing.set(String(r.collection_key), r);
  const open: Row[] = [];
  const seen = new Set<string>();
  for (const o of s.owed) {
    const kind = kindOf(o);
    const key = keyOf(kind, o.row.ROWID);
    seen.add(key);
    const fields: Row = {
      amount: round(o.amount, 2), total: toNum(kind === "FEE" ? o.row.fee_total : o.row.invoice_total) || round(o.amount, 2), due_date: o.due,
      invoice_number: kind === "FEE" ? null : o.row.invoice_number ?? null, zoho_books_invoice_id: o.row.zoho_books_invoice_id ?? null,
      invoiced_on: day(kind === "FEE" ? o.row.signed_at : kind === "INSTALMENT" ? o.row.invoiced_on : o.row.reviewed_at),
      project_id: s.projectOf(o.row) || null, franchisee_id: o.row.franchisee_id ?? null,
      period: kind === "ROYALTY" ? String(o.row.period) : null, label: kind === "INSTALMENT" ? String(o.row.label ?? "") : kind === "FEE" ? "Franchise fee" : null,
    };
    const have = existing.get(key);
    if (!have) {
      open.push(await repo.insert("collections", { ...fields, collection_key: key, kind, source_id: String(o.row.ROWID), status: "OPEN", step: -1, reminders_sent: 0, escalated: false, promise_broken: false }));
      continue;
    }
    const changed = Object.entries(fields).some(([k, v]) => String(have[k] ?? "") !== String(v ?? ""));
    open.push(changed ? await repo.update("collections", String(have.ROWID), fields) : have);
  }
  // No longer owed: paid, or the invoice went away.
  let paid = 0, closed = 0;
  for (const [key, row] of existing) {
    if (seen.has(key)) continue;
    const source = sourceOf(s, row);
    const paidOn = source ? day(row.kind === "FEE" ? source.fee_paid_on : source.paid_on) : null;
    const gone = !source || (row.kind === "FEE" ? source.fee_status === "VOID" : ["WAIVED", "REFUNDED", "VOID"].includes(String(source.status)));
    if (gone) { closed++; await repo.update("collections", String(row.ROWID), { status: "CLOSED", closed_on: today }); continue; }
    const on = paidOn ?? today;
    paid++;
    await repo.update("collections", String(row.ROWID), { status: "PAID", paid_on: on, days_to_pay: row.invoiced_on ? Math.max(0, daysBetween(String(row.invoiced_on), on)) : null, amount: 0 });
  }
  return { open, paid, closed };
}

function sourceOf(s: Sources, c: Row): Row | null {
  const id = String(c.source_id);
  const rows = c.kind === "FEE" ? s.agreements : c.kind === "INSTALMENT" ? s.instalments : s.reports;
  return rows.find((r) => String(r.ROWID) === id) ?? null;
}

/** The ladder step an item has reached today: the last step whose day has come. */
export function stepDue(ladder: LadderStep[], due: string | null, today: string): number {
  if (!due) return -1;
  const from = daysBetween(due, today);
  let i = -1;
  ladder.forEach((s, n) => { if (s.days <= from) i = n; });
  return i;
}

export interface LadderResult { reminders: number; escalations: number; broken: number; paid: number }

/**
 * The daily chase. Each open item moves to the ladder step its age has reached, and the people on that
 * step hear once; a promise to pay holds the ladder until its date, and a broken promise tells finance.
 * A disputed item is left alone until someone resumes it.
 */
export async function runLadder(store: Store, ctx: TenantContext, today: string, now: Date): Promise<LadderResult> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const { ladder } = collectionsSettings(tenant);
  const src = await collectionSources(repo);
  const codes = new Map(src.projects.map((p) => [String(p.ROWID), String(p.project_code)]));
  const synced = await syncCollections(store, ctx, today, src);
  const out: LadderResult = { reminders: 0, escalations: 0, broken: 0, paid: synced.paid };
  for (let c of synced.open) {
    if (c.status === "DISPUTED" || !c.due_date) continue;
    const who = codes.get(String(c.project_id)) ?? String(sourceOf(src, c)?.agreement_code ?? "Store");
    if (c.status === "PROMISED") {
      if (today <= String(c.promise_date)) continue;
      // The promised day has passed and the invoice is still open.
      c = await repo.update("collections", String(c.ROWID), { status: "OPEN", promise_broken: true });
      out.broken += await deliver(store, ctx, {
        kind: "collection.broken", entityType: "collection", entityId: String(c.ROWID), roles: ["FINANCE_MANAGER"],
        title: `${who} missed the promised payment of ${inr(toNum(c.amount))}`, body: `${describeCollection(c)}${c.invoice_number ? ` (${c.invoice_number})` : ""} was promised for ${nice(c.promise_date)}${c.promise_note ? `: “${String(c.promise_note).slice(0, 120)}”` : ""}. It is still unpaid.`,
        link: "/collections", dedupe: `collect:${c.collection_key}:broken:${c.promise_date}`,
      }, now);
    }
    const i = stepDue(ladder, day(c.due_date), today);
    if (i < 0 || i <= toNum(c.step)) continue;
    const step = ladder[i];
    const sent = await sendStep(store, ctx, c, step, i, who, today, now);
    out.reminders += sent.franchisee;
    out.escalations += sent.staff;
    await repo.update("collections", String(c.ROWID), { step: i, step_sent_on: today, reminders_sent: toNum(c.reminders_sent) + (sent.franchisee ? 1 : 0), ...(step.flag ? { escalated: true } : {}) });
  }
  return out;
}

/** The wording of one step for the franchisee and for staff, each delivered once per step. */
async function sendStep(store: Store, ctx: TenantContext, c: Row, step: LadderStep, i: number, who: string, today: string, now: Date, manual = false): Promise<{ franchisee: number; staff: number }> {
  const from = daysBetween(String(c.due_date).slice(0, 10), today); // negative before the due date
  const late = Math.max(0, from);
  const what = describeCollection(c), amount = inr(toNum(c.amount)), inv = c.invoice_number ? `invoice ${c.invoice_number}` : "the invoice";
  const franchiseeLink = c.kind === "ROYALTY" ? "/portal/sales" : "/portal/funding";
  const suffix = manual ? `:manual:${now.getTime()}` : `:${i}`;
  const out = { franchisee: 0, staff: 0 };
  if (step.franchisee || manual) {
    const title = from > 0 ? `${amount} for ${what} is ${late} day${late === 1 ? "" : "s"} overdue` : from === 0 ? `${amount} for ${what} is due today` : `${amount} for ${what} is due ${nice(c.due_date)}`;
    out.franchisee += await deliver(store, ctx, {
      kind: late > 0 ? "collection.overdue" : "collection.due", entityType: "collection", entityId: String(c.ROWID), userIds: await portalUsers(store, ctx.tenantId, c.franchisee_id),
      title, body: `Pay ${inv} by bank transfer using the details on it${late > 0 ? `; it was due ${nice(c.due_date)}` : ""}. Tell us the UTR once sent and the invoice closes the same day.`,
      link: franchiseeLink, dedupe: `collect:${c.collection_key}${suffix}:fr`,
    }, now);
  }
  if (step.roles.length && !manual) {
    out.staff += await deliver(store, ctx, {
      kind: step.flag ? "collection.escalated" : "collection.late", entityType: "collection", entityId: String(c.ROWID), roles: step.roles,
      title: `${who}: ${amount} for ${what} is ${late} day${late === 1 ? "" : "s"} late${step.flag ? ", escalated" : ""}`,
      body: `${inv.charAt(0).toUpperCase() + inv.slice(1)} was due ${nice(c.due_date)}.${step.flag ? " The store is flagged on the dashboard until it is paid." : ""} Work it from Collections: record a promise, a call, a dispute or the payment.`,
      link: "/collections", dedupe: `collect:${c.collection_key}${suffix}:staff`,
    }, now);
  }
  return out;
}

// ---- Actions from the worklist ----

async function mustOpen(repo: TenantRepo, id: string): Promise<Row> {
  const row = await repo.findOne("collections", { ROWID: id });
  if (!row) throw new AppError("NOT_FOUND", "No such collection item.");
  if (!OPEN_COLLECTION.includes(String(row.status))) throw new AppError("INVALID_TRANSITION", "This invoice is already settled.");
  return row;
}

export async function promiseToPay(store: Store, ctx: TenantContext, id: string, date: string, note: string | null): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  const out = await repo.update("collections", String(row.ROWID), { status: "PROMISED", promise_date: date, promise_note: note, promised_at: new Date().toISOString(), promise_broken: false, last_contact_at: new Date().toISOString(), last_contact_note: note ?? `Promised to pay by ${nice(date)}` });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:promise", metadata: { project_id: row.project_id, invoice: row.invoice_number, amount: row.amount, date, note } });
  return out;
}

export async function addContactNote(store: Store, ctx: TenantContext, id: string, note: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  const out = await repo.update("collections", String(row.ROWID), { last_contact_at: new Date().toISOString(), last_contact_note: note });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:note", metadata: { project_id: row.project_id, invoice: row.invoice_number, note } });
  return out;
}

export async function disputeCollection(store: Store, ctx: TenantContext, id: string, reason: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  const out = await repo.update("collections", String(row.ROWID), { status: "DISPUTED", dispute_reason: reason, disputed_at: new Date().toISOString(), last_contact_at: new Date().toISOString(), last_contact_note: `Disputed: ${reason}` });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:disputed", metadata: { project_id: row.project_id, invoice: row.invoice_number, amount: row.amount, reason } });
  return out;
}

export async function resumeCollection(store: Store, ctx: TenantContext, id: string, note: string | null): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  if (row.status !== "DISPUTED") throw new AppError("INVALID_TRANSITION", "Only a disputed invoice can be resumed.");
  const out = await repo.update("collections", String(row.ROWID), { status: "OPEN", dispute_reason: null, last_contact_at: new Date().toISOString(), last_contact_note: note ?? "Dispute resolved, reminders resume" });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:resumed", metadata: { project_id: row.project_id, invoice: row.invoice_number, note } });
  return out;
}

/** Sends the franchisee today's reminder now, whatever the ladder says. */
export async function remindNow(store: Store, ctx: TenantContext, id: string, today: string, now: Date): Promise<{ sent: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  const sent = await sendStep(store, ctx, row, { days: 0, franchisee: true, roles: [], flag: false }, -1, "", today, now, true);
  if (!sent.franchisee) throw new AppError("VALIDATION_FAILED", "The franchisee has no active portal user to remind.", { franchisee: "no portal user" });
  await repo.update("collections", String(row.ROWID), { reminders_sent: toNum(row.reminders_sent) + 1, last_contact_at: now.toISOString(), last_contact_note: "Reminder sent" });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:reminded", metadata: { project_id: row.project_id, invoice: row.invoice_number, amount: row.amount } });
  return { sent: sent.franchisee };
}

export const PAYMENT_MODES = ["banktransfer", "upi", "cash", "check", "creditcard", "others"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export interface PaymentInput { amount: number; paid_on: string; mode: PaymentMode; reference: string | null; note: string | null }

/**
 * A payment finance received outside the gateway (NEFT, RTGS, UPI, a cheque): recorded in Books against
 * the invoice, then the invoice is re-read so the fee, instalment or report closes as if Books had told us.
 */
export async function recordCollectionPayment(store: Store, ctx: TenantContext, books: ZohoBooksClient | null, id: string, input: PaymentInput, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await mustOpen(repo, id);
  if (!books) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
  if (!books.recordPayment) throw new AppError("ZOHO_SYNC_FAILED", "This Books connection cannot record payments.");
  if (!row.zoho_books_invoice_id) throw new AppError("VALIDATION_FAILED", "This invoice has no Zoho Books id yet; check fees in Books first.", { invoice: "not in Books" });
  if (input.amount > toNum(row.amount) + 0.005) throw new AppError("VALIDATION_FAILED", `Only ${inr(toNum(row.amount))} is outstanding on this invoice.`, { amount: "more than the balance" });
  const franchisee = row.franchisee_id ? await repo.findOne("franchisees", { ROWID: String(row.franchisee_id) }) : null;
  if (!franchisee?.zoho_books_customer_id) throw new AppError("VALIDATION_FAILED", "The franchisee has no Zoho Books customer yet.", { franchisee: "no Books customer" });
  const src = await collectionSources(repo);
  const source = sourceOf(src, row);
  if (!source) throw new AppError("NOT_FOUND", "The invoice this item was raised for is gone.");
  // The invoice as Books has it: it must be this franchisee's, and the amount must still be open there.
  const inv = await books.getInvoice(String(row.zoho_books_invoice_id));
  if (inv.customer_id && String(inv.customer_id) !== String(franchisee.zoho_books_customer_id)) {
    throw new AppError("INVOICE_CONFLICT", `Invoice ${inv.number || row.invoice_number} in Zoho Books belongs to another customer. Fix the link before recording a payment.`, { invoice: "another customer's invoice" });
  }
  if (input.amount > inv.balance + 0.005) throw new AppError("VALIDATION_FAILED", `Only ${inr(inv.balance)} is still open on ${inv.number || row.invoice_number} in Zoho Books.`, { amount: "more than the balance in Books" });
  const payment = await books.recordPayment({
    customer_id: String(franchisee.zoho_books_customer_id), payment_mode: input.mode, amount: round(input.amount, 2), date: input.paid_on,
    reference_number: input.reference ?? undefined, description: input.note ?? `${describeCollection(row)} for ${franchisee.display_name ?? franchisee.franchise_code}`,
    invoices: [{ invoice_id: String(row.zoho_books_invoice_id), amount_applied: round(input.amount, 2) }],
  });
  await logActivity(store, ctx, { entityType: "collection", entityId: id, action: "collection:payment", metadata: { project_id: row.project_id, invoice: row.invoice_number, amount: input.amount, mode: input.mode, reference: input.reference, paid_on: input.paid_on, payment_id: payment.id, payment_number: payment.number ?? null } });
  try {
    if (row.kind === "FEE") await refreshFee(store, ctx, books, null, source, now);
    else if (row.kind === "INSTALMENT") await refreshInstalment(store, ctx, books, source, src.agreements.find((a) => String(a.ROWID) === String(source.agreement_id)) ?? null);
    else await refreshReport(store, ctx, books, source);
  } catch (e) {
    // Books has the payment; the nightly sync will close the invoice if this read failed.
    log("warn", "collection.refresh_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, collection_id: id, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  await repo.update("collections", String(row.ROWID), { last_contact_at: now.toISOString(), last_contact_note: `${inr(input.amount)} received by ${input.mode === "banktransfer" ? "bank transfer" : input.mode}${input.reference ? ` (${input.reference})` : ""}` });
  await syncCollections(store, ctx, now.toISOString().slice(0, 10));
  return (await repo.findOne("collections", { ROWID: String(row.ROWID) }))!;
}

// ---- Behaviour: what the dashboard and the health score read ----

export interface PaymentBehaviour { billed: number; collected: number; rate_pct: number | null; days_to_pay: number | null; paid_count: number }

/** Invoices dated in a window, from the three sources, with their collected share and days to pay. */
export function paymentBehaviour(agreements: Row[], instalments: Row[], reports: Row[], today: string, opts: { days?: number; projectId?: string; projectOf?: (row: Row) => string } = {}): PaymentBehaviour {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (opts.days ?? 90) * 86_400_000).toISOString().slice(0, 10);
  const mine = (row: Row) => !opts.projectId || !opts.projectOf || opts.projectOf(row) === opts.projectId;
  const items: { on: string; total: number; balance: number; paid_on: string | null; void: boolean }[] = [];
  for (const a of agreements) {
    if (!a.fee_status || !a.signed_at || !mine(a)) continue;
    items.push({ on: String(a.signed_at).slice(0, 10), total: toNum(a.fee_total), balance: toNum(a.fee_balance), paid_on: day(a.fee_paid_on), void: a.fee_status === "VOID" });
  }
  const signing = new Set(agreements.map((a) => String(a.zoho_books_invoice_id ?? "")).filter(Boolean));
  for (const i of instalments) {
    if (!["INVOICED", "PAID"].includes(String(i.status)) || !i.invoiced_on || !mine(i)) continue;
    if (i.zoho_books_invoice_id && signing.has(String(i.zoho_books_invoice_id))) continue; // the agreement's own invoice, counted above
    items.push({ on: String(i.invoiced_on).slice(0, 10), total: toNum(i.invoice_total), balance: i.status === "PAID" ? 0 : toNum(i.invoice_balance), paid_on: day(i.paid_on), void: false });
  }
  for (const r of reports) {
    if (!["INVOICED", "PAID"].includes(String(r.status)) || !r.reviewed_at || !r.zoho_books_invoice_id || !mine(r)) continue;
    items.push({ on: String(r.reviewed_at).slice(0, 10), total: toNum(r.invoice_total), balance: r.status === "PAID" ? 0 : toNum(r.invoice_balance), paid_on: day(r.paid_on), void: false });
  }
  const window = items.filter((x) => !x.void && x.on >= since && x.total > 0);
  const billed = round(window.reduce((a, x) => a + x.total, 0), 2);
  const collected = round(window.reduce((a, x) => a + Math.max(0, x.total - x.balance), 0), 2);
  const paid = items.filter((x) => !x.void && x.balance <= 0 && x.paid_on && x.paid_on >= since).map((x) => Math.max(0, daysBetween(x.on, x.paid_on!)));
  return {
    billed, collected, rate_pct: billed > 0 ? round((collected / billed) * 100, 1) : null,
    days_to_pay: paid.length ? Math.round(paid.reduce((a, d) => a + d, 0) / paid.length) : null, paid_count: paid.length,
  };
}
