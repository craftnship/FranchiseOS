import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toNum } from "../common/values";
import { ZohoBooksClient } from "../integrations/clients";
import { onboardingSettings } from "./agreements";

// Royalties (plan Phase 2 "Operations"): an opened store reports its monthly sales; finance approves
// the report, which raises the royalty and marketing-fund invoice in Books; payment comes back by sync.
//
// SUBMITTED → (approve) INVOICED → (Books paid) PAID
//           ↘ (return) RETURNED → (franchisee edits) SUBMITTED

export const REPORT_STATES = ["SUBMITTED", "RETURNED", "INVOICED", "PAID"] as const;
const EDITABLE = new Set(["SUBMITTED", "RETURNED"]);

const round2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
export const periodOf = (date: string) => date.slice(0, 7);
/** A store's opening month counts as trading only when it opened on the 1st; a part month would drag its average down. */
export const tradedFullMonth = (openedOn: unknown, period: unknown) => !openedOn || String(period) !== periodOf(String(openedOn)) || String(openedOn).slice(8, 10) === "01";
export function nextPeriod(p: string): string {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
export function prevPeriod(p: string): string {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export interface RoyaltySettings {
  /** Defaults when neither the store nor its feasibility model sets a rate. */
  royalty_pct: number | null;
  marketing_fund_pct: number | null;
  /** Day of the month by which last month's sales are due. */
  report_due_day: number;
}

export function royaltySettings(tenant: Row | null): RoyaltySettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const pct = (v: unknown) => (v == null || v === "" ? null : toNum(v));
  return { royalty_pct: pct(s.royalty_pct), marketing_fund_pct: pct(s.marketing_fund_pct), report_due_day: s.sales_report_due_day != null ? Math.min(28, Math.max(1, toNum(s.sales_report_due_day))) : 7 };
}

const has = (v: unknown) => v !== null && v !== undefined && v !== "" && String(v) !== "null";

/** The store's rates: set on the project, else the feasibility model it was approved on, else the tenant default. */
export async function ratesFor(store: Store, ctx: Pick<TenantContext, "tenantId">, project: Row): Promise<Rates> {
  if (has(project.royalty_pct)) return ratesFrom(project, null, null);
  const repo = new TenantRepo(store, ctx.tenantId);
  const model = project.application_id ? (await repo.findMany("feasibility_models", { application_id: String(project.application_id) }, { orderBy: "ROWID", desc: true, limit: 1 }))[0] : null;
  if (model && has(model.royalty_pct)) return ratesFrom(project, model, null);
  return ratesFrom(project, model ?? null, await store.findOne("tenants", { ROWID: ctx.tenantId }));
}

export interface Rates { royalty_pct: number | null; marketing_fund_pct: number | null; source: "store" | "feasibility" | "tenant" | null }

/** The same choice as ratesFor, from rows already loaded (the store's latest feasibility model, the tenant). */
export function ratesFrom(project: Row, model: Row | null, tenant: Row | null): Rates {
  if (has(project.royalty_pct)) return { royalty_pct: toNum(project.royalty_pct), marketing_fund_pct: has(project.marketing_fund_pct) ? toNum(project.marketing_fund_pct) : 0, source: "store" };
  if (model && has(model.royalty_pct)) return { royalty_pct: toNum(model.royalty_pct), marketing_fund_pct: has(model.marketing_fund_pct) ? toNum(model.marketing_fund_pct) : 0, source: "feasibility" };
  const s = royaltySettings(tenant);
  if (s.royalty_pct != null) return { royalty_pct: s.royalty_pct, marketing_fund_pct: s.marketing_fund_pct ?? 0, source: "tenant" };
  return { royalty_pct: null, marketing_fund_pct: null, source: null };
}

/** Months the store must report: from its opening month to last month. */
export function duePeriods(project: Row, today: string): string[] {
  if (project.status !== "OPENED" || !project.actual_opening_date) return [];
  const out: string[] = [];
  const last = prevPeriod(periodOf(today));
  for (let p = periodOf(String(project.actual_opening_date)); p <= last && out.length < 120; p = nextPeriod(p)) out.push(p);
  return out;
}

export interface SalesInput { period: string; gross_sales: number; net_sales: number; transactions?: number | null; notes?: string | null; file_ref?: string }

export async function submitReport(store: Store, ctx: TenantContext, project: Row, input: SalesInput, today: string, by: "PORTAL" | "STAFF"): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (project.status !== "OPENED") throw new AppError("INVALID_TRANSITION", "Sales are reported once the store has opened.");
  if (!duePeriods(project, today).includes(input.period)) {
    throw new AppError("VALIDATION_FAILED", "Report a finished month since the store opened.", { period: input.period >= periodOf(today) ? "month not finished yet" : "before the store opened" });
  }
  if (input.net_sales > input.gross_sales) throw new AppError("VALIDATION_FAILED", "Net sales can't be more than gross sales.", { net_sales: "more than gross" });
  const key = `${ctx.tenantId}:${project.ROWID}:${input.period}`;
  const existing = await repo.findOne("sales_reports", { period_key: key });
  const fields: Row = {
    gross_sales: round2(input.gross_sales), net_sales: round2(input.net_sales), transactions: input.transactions ?? null, notes: input.notes ?? null,
    ...(input.file_ref ? { file_ref: input.file_ref } : {}), status: "SUBMITTED", submitted_by: ctx.userId, submitted_at: new Date().toISOString(), source: by,
  };
  let row: Row;
  if (existing) {
    if (!EDITABLE.has(String(existing.status))) throw new AppError("INVALID_TRANSITION", `The ${periodLabel(input.period)} report is already invoiced. Ask finance to correct it.`);
    row = await repo.update("sales_reports", String(existing.ROWID), fields);
  } else {
    try {
      row = await repo.insert("sales_reports", { ...fields, project_id: String(project.ROWID), franchisee_id: project.franchisee_id ?? null, period: input.period, period_key: key });
    } catch (e) {
      if (e instanceof DuplicateKeyError) throw new AppError("INVALID_TRANSITION", "This month was just reported. Refresh to see it.");
      throw e;
    }
  }
  await logActivity(store, ctx, {
    entityType: "sales_report", entityId: String(row.ROWID), action: existing ? "royalty:resubmitted" : "royalty:submitted",
    metadata: { project_id: String(project.ROWID), period: input.period, gross_sales: fields.gross_sales, net_sales: fields.net_sales, by, submitted_at: fields.submitted_at },
  });
  return row;
}

/** Sends a report back to the franchisee with a note. */
export async function returnReport(store: Store, ctx: TenantContext, report: Row, note: string): Promise<Row> {
  if (report.status !== "SUBMITTED") throw new AppError("INVALID_TRANSITION", "Only a submitted report can be returned.");
  const row = await new TenantRepo(store, ctx.tenantId).update("sales_reports", String(report.ROWID), { status: "RETURNED", review_note: note, reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() });
  await logActivity(store, ctx, { entityType: "sales_report", entityId: String(report.ROWID), action: "royalty:returned", metadata: { project_id: String(report.project_id), period: report.period, note } });
  return row;
}

/** The store's franchisee with a Books customer id; made here for stores set up without one (normally made at signing). */
export async function booksCustomerFor(repo: TenantRepo, books: ZohoBooksClient, project: Row): Promise<Row> {
  const franchisee = project.franchisee_id ? await repo.findOne("franchisees", { ROWID: String(project.franchisee_id) }) : null;
  if (!franchisee) throw new AppError("VALIDATION_FAILED", "This store has no franchisee to invoice.", { franchisee: "missing" });
  if (franchisee.zoho_books_customer_id) return franchisee;
  const name = String(franchisee.legal_name || franchisee.display_name || franchisee.franchise_code);
  const email = franchisee.email ? String(franchisee.email) : undefined;
  const ref = await books.findCustomer(name, email) ?? await books.createCustomer({ contact_name: name, company_name: franchisee.legal_name ? String(franchisee.legal_name) : undefined, email, phone: franchisee.phone ? String(franchisee.phone) : undefined });
  return repo.update("franchisees", String(franchisee.ROWID), { zoho_books_customer_id: ref.id });
}

export const invoiceRef = (project: Row, period: string) => `ROY-${project.project_code}-${period.replace("-", "")}`;

/**
 * Approves a submitted report: works out royalty and marketing fund at the store's rates and raises
 * one Books invoice for both (found by reference first, so a retry never makes a second one).
 */
export async function approveReport(store: Store, ctx: TenantContext, books: ZohoBooksClient | null, project: Row, report: Row, now: Date): Promise<Row> {
  if (report.status !== "SUBMITTED") throw new AppError("INVALID_TRANSITION", "Only a submitted report can be approved.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const rates = await ratesFor(store, ctx, project);
  if (rates.royalty_pct == null) throw new AppError("VALIDATION_FAILED", "Set this store's royalty rate first.", { royalty_pct: "not set" });
  if (!books) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
  const franchisee = await booksCustomerFor(repo, books, project);
  const net = toNum(report.net_sales);
  const royalty = round2(net * rates.royalty_pct / 100);
  const marketing = round2(net * (rates.marketing_fund_pct ?? 0) / 100);
  const settings = onboardingSettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));
  const ref = invoiceRef(project, String(report.period));
  const label = periodLabel(String(report.period));
  const tax = settings.books_tax_id ? { tax_id: settings.books_tax_id } : {};
  const lines = [
    { name: "Royalty", description: `${rates.royalty_pct}% of net sales ${label}, store ${project.project_code}`, rate: royalty, quantity: 1, ...tax },
    ...(marketing > 0 ? [{ name: "Marketing fund", description: `${rates.marketing_fund_pct}% of net sales ${label}, store ${project.project_code}`, rate: marketing, quantity: 1, ...tax }] : []),
  ];
  const found = await books.findInvoice(ref);
  const invoice = found ?? (royalty + marketing > 0 ? await books.createInvoice({ customer_id: String(franchisee.zoho_books_customer_id), reference_number: ref, date: now.toISOString().slice(0, 10), payment_terms: settings.books_payment_terms, line_items: lines }) : null);
  let state: Row = {};
  if (invoice) {
    try {
      const inv = await books.getInvoice(invoice.id);
      if (inv.status === "draft") await books.sendInvoice(invoice.id, settings.books_email_invoice && franchisee.email ? [String(franchisee.email)] : []);
      const after = inv.status === "draft" ? await books.getInvoice(invoice.id) : inv;
      state = { invoice_number: after.number, invoice_status: after.status, invoice_total: after.total, invoice_balance: after.balance, invoice_due_date: after.due_date };
    } catch (e) {
      // The invoice exists; its number and status arrive with the next sync.
      log("warn", "royalty.invoice_state_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  const zero = !invoice;
  const row = await repo.update("sales_reports", String(report.ROWID), {
    status: zero ? "PAID" : "INVOICED", royalty_pct: rates.royalty_pct, marketing_fund_pct: rates.marketing_fund_pct ?? 0, royalty_amount: royalty, marketing_amount: marketing,
    zoho_books_invoice_id: invoice?.id ?? null, reviewed_by: ctx.userId, reviewed_at: now.toISOString(), review_note: null, ...state,
  });
  await logActivity(store, ctx, {
    entityType: "sales_report", entityId: String(report.ROWID), action: "royalty:invoiced",
    metadata: { project_id: String(project.ROWID), period: report.period, net_sales: net, royalty, marketing, invoice_ref: ref, invoice_number: state.invoice_number ?? null, zero },
  });
  return row;
}

/** Re-reads an invoiced report's Books invoice; paid moves the report to PAID. */
export async function refreshReport(store: Store, ctx: TenantContext, books: ZohoBooksClient, report: Row): Promise<Row> {
  if (!report.zoho_books_invoice_id || report.status !== "INVOICED") return report;
  const inv = await books.getInvoice(String(report.zoho_books_invoice_id));
  const paid = inv.status === "paid" || toNum(inv.balance) <= 0;
  const patch: Row = { invoice_number: inv.number, invoice_status: inv.status, invoice_total: inv.total, invoice_balance: inv.balance, invoice_due_date: inv.due_date };
  if (paid) patch.status = "PAID";
  const row = await new TenantRepo(store, ctx.tenantId).update("sales_reports", String(report.ROWID), patch);
  if (paid) await logActivity(store, ctx, { entityType: "sales_report", entityId: String(report.ROWID), action: "royalty:paid", metadata: { project_id: String(report.project_id), period: report.period, invoice_number: inv.number, paid_on: inv.last_payment_date ?? null } });
  return row;
}

/** Daily: refresh every unpaid royalty invoice of the tenant. */
export async function syncTenantRoyalties(store: Store, ctx: TenantContext, books: ZohoBooksClient): Promise<{ checked: number; paid: number; failed: number }> {
  const out = { checked: 0, paid: 0, failed: 0 };
  const repo = new TenantRepo(store, ctx.tenantId);
  for (const r of await repo.findMany("sales_reports", { status: "INVOICED" })) {
    try {
      out.checked++;
      if ((await refreshReport(store, ctx, books, r)).status === "PAID") out.paid++;
    } catch (e) {
      out.failed++;
      log("warn", "royalty.sync_failed", { tenant_id: ctx.tenantId, report_id: String(r.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}

/** One store's royalty picture: every month due, its report if any, and the totals. */
export async function royaltyLedger(store: Store, ctx: TenantContext, project: Row, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const reports = await repo.findMany("sales_reports", { project_id: String(project.ROWID) }, { orderBy: "period", desc: true, limit: 300 });
  const byPeriod = new Map(reports.map((r) => [String(r.period), r]));
  const s = royaltySettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));
  const due = duePeriods(project, today);
  const thisMonth = periodOf(today);
  const months = [...due].reverse().map((p) => {
    const r = byPeriod.get(p) ?? null;
    const dueOn = `${nextPeriod(p)}-${String(s.report_due_day).padStart(2, "0")}`;
    return { period: p, label: periodLabel(p), due_on: dueOn, late: !r && today > dueOn, report: r };
  });
  const sum = (k: string, f: (r: Row) => boolean = () => true) => round2(reports.filter(f).reduce((a, r) => a + toNum(r[k]), 0));
  const invoiced = (r: Row) => r.status === "INVOICED" || r.status === "PAID";
  return {
    rates: await ratesFor(store, ctx, project), report_due_day: s.report_due_day, this_month: thisMonth,
    months,
    totals: {
      net_sales: sum("net_sales", invoiced), royalty: sum("royalty_amount", invoiced), marketing: sum("marketing_amount", invoiced),
      outstanding: sum("invoice_balance", (r) => r.status === "INVOICED"), missing: months.filter((m) => !m.report || m.report.status === "RETURNED").length,
      waiting: reports.filter((r) => r.status === "SUBMITTED").length,
    },
  };
}
