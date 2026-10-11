import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toNum } from "../common/values";
import { ZohoBooksClient } from "../integrations/clients";
import { FeeKind, FeeStep, FeeTrigger, feePlan, onboardingSettings } from "./agreements";
import { ensureBudget } from "./capex";
import { booksCustomerFor } from "./royalties";

// Funding and fees. The franchise fee is a schedule of instalments per store (plus an optional
// refundable security deposit); each is raised as a Books invoice when its trigger is met (signing,
// a checklist task done, the store opening, or a date), and payment comes back by sync. The
// franchisee's own funding (own capital and a bank loan) is tracked against the capex budget.
//
// Instalment: SCHEDULED → (raise) INVOICED → (Books paid) PAID → (deposit only) REFUNDED
//             SCHEDULED → (waive) WAIVED
// Loan:       PLANNED → APPLIED → SANCTIONED → DISBURSING → DISBURSED, or APPLIED → REJECTED → APPLIED

const OPEN_PROJECT = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING", "OPENED"];

const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (date: string, days: number) => { const d = new Date(date.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const parse = <T>(v: unknown, fallback: T): T => { try { return v ? JSON.parse(String(v)) as T : fallback; } catch { return fallback; } };

/** The signed agreement behind a project. */
export async function agreementFor(repo: TenantRepo, project: Row): Promise<Row | null> {
  if (!project.application_id) return null;
  return (await repo.findMany("agreements", { application_id: String(project.application_id), status: "SIGNED" }, { limit: 1 }))[0] ?? null;
}

/** An instalment that is the agreement's own signing invoice; its state follows the agreement (fees.ts). */
const adopted = (row: Row, agreement: Row | null) => !!agreement?.zoho_books_invoice_id && row.zoho_books_invoice_id === agreement.zoho_books_invoice_id;

function fromAgreement(agreement: Row): Row {
  const paid = agreement.fee_status === "PAID";
  return {
    status: paid ? "PAID" : "INVOICED", invoice_status: agreement.fee_status ? String(agreement.fee_status).toLowerCase() : null,
    invoice_total: agreement.fee_total ?? null, invoice_balance: agreement.fee_balance ?? null, invoice_due_date: agreement.fee_due_date ?? null, paid_on: paid ? agreement.fee_paid_on ?? null : null,
  };
}

/**
 * The project's instalments, made once from the plan the agreement was signed on. An agreement
 * signed before schedules existed invoiced the whole fee on signing, so its schedule is that one
 * invoice (plus the deposit, if the tenant charges one).
 */
export async function ensureSchedule(store: Store, ctx: TenantContext, project: Row, agreement: Row | null): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const existing = await repo.findMany("fee_instalments", { project_id: pid }, { orderBy: "seq", limit: 100 });
  if (existing.length || !agreement) return existing;
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  let steps: FeeStep[];
  if (agreement.fee_plan_json) steps = parse<FeeStep[]>(agreement.fee_plan_json, []);
  else if (agreement.zoho_books_invoice_id) steps = [{ kind: "FEE", label: "Franchise fee", amount: onboardingSettings(tenant).franchise_fee, trigger: "SIGNING" }, ...feePlan(tenant).filter((s) => s.kind === "DEPOSIT")];
  else steps = feePlan(tenant);
  const signedOn = String(agreement.signed_at ?? agreement.effective_date ?? new Date().toISOString()).slice(0, 10);
  let adoptedOne = false;
  const rows: Row[] = [];
  for (const [i, s] of steps.entries()) {
    const takesInvoice = !adoptedOne && s.kind === "FEE" && s.trigger === "SIGNING" && !!agreement.zoho_books_invoice_id;
    if (takesInvoice) adoptedOne = true;
    try {
      rows.push(await repo.insert("fee_instalments", {
        project_id: pid, agreement_id: String(agreement.ROWID), franchisee_id: project.franchisee_id ?? null, seq: i + 1, kind: s.kind, label: s.label, amount: s.amount,
        raise_on: s.trigger, task_code: s.trigger === "TASK" ? s.task_code ?? null : null, due_on: s.trigger === "DATE" ? addDays(signedOn, s.days ?? 0) : null,
        status: "SCHEDULED", instalment_key: `${ctx.tenantId}:${pid}:${i + 1}`,
        ...(takesInvoice ? { zoho_books_invoice_id: agreement.zoho_books_invoice_id, invoice_ref: agreement.agreement_code, invoiced_on: signedOn, ...fromAgreement(agreement) } : {}),
      }));
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
      return repo.findMany("fee_instalments", { project_id: pid }, { orderBy: "seq", limit: 100 });
    }
  }
  return rows;
}

/** Why a scheduled instalment is (or isn't yet) due. */
export function dueState(row: Row, project: Row, tasks: Row[], today: string): { due: boolean; when: string } {
  switch (row.raise_on) {
    case "SIGNING": return { due: true, when: "On signing" };
    case "OPENING": return { due: project.status === "OPENED", when: "When the store opens" };
    case "DATE": return { due: !!row.due_on && String(row.due_on).slice(0, 10) <= today, when: `On ${String(row.due_on ?? "").slice(0, 10)}` };
    case "TASK": {
      const t = tasks.find((x) => x.task_code === row.task_code);
      return { due: t?.status === "COMPLETED", when: `When “${t?.item ?? row.task_code}” is done` };
    }
    default: return { due: false, when: "" };
  }
}

export interface InstalmentInput { kind: FeeKind; label: string; amount: number; raise_on: FeeTrigger; task_code?: string | null; due_on?: string | null }

async function checkInput(repo: TenantRepo, project: Row, input: InstalmentInput): Promise<void> {
  if (input.raise_on === "TASK") {
    const tasks = await repo.findMany("opening_checklists", { project_id: String(project.ROWID) }, { limit: 300 });
    if (!input.task_code || !tasks.some((t) => t.task_code === input.task_code)) throw new AppError("VALIDATION_FAILED", "Choose one of this store's checklist tasks.", { task_code: "not a task of this store" });
  }
  if (input.raise_on === "DATE" && !input.due_on) throw new AppError("VALIDATION_FAILED", "Give the date it's due.", { due_on: "required" });
}

/** Adds an instalment, or changes one that isn't invoiced yet. */
export async function saveInstalment(store: Store, ctx: TenantContext, project: Row, agreement: Row, input: InstalmentInput, existing?: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (existing && existing.status !== "SCHEDULED") throw new AppError("INVALID_TRANSITION", "Only an instalment that isn't invoiced yet can be changed.");
  await checkInput(repo, project, input);
  const fields: Row = {
    kind: input.kind, label: input.label, amount: round2(input.amount), raise_on: input.raise_on,
    task_code: input.raise_on === "TASK" ? input.task_code : null, due_on: input.raise_on === "DATE" ? input.due_on : null,
  };
  let row: Row;
  if (existing) row = await repo.update("fee_instalments", String(existing.ROWID), fields);
  else {
    const all = await ensureSchedule(store, ctx, project, agreement);
    const seq = all.reduce((m, r) => Math.max(m, toNum(r.seq)), 0) + 1;
    row = await repo.insert("fee_instalments", { ...fields, project_id: String(project.ROWID), agreement_id: String(agreement.ROWID), franchisee_id: project.franchisee_id ?? null, seq, status: "SCHEDULED", instalment_key: `${ctx.tenantId}:${project.ROWID}:${seq}` });
  }
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: existing ? "fee:changed" : "fee:added", metadata: { fee_id: String(row.ROWID), label: input.label, kind: input.kind, amount: fields.amount, raise_on: input.raise_on, ...(existing ? { from: { amount: toNum(existing.amount), raise_on: existing.raise_on } } : {}) } });
  return row;
}

/** Drops an instalment that isn't invoiced yet; the row stays for the record. */
export async function waiveInstalment(store: Store, ctx: TenantContext, project: Row, row: Row, note: string): Promise<Row> {
  if (row.status !== "SCHEDULED") throw new AppError("INVALID_TRANSITION", "Only an instalment that isn't invoiced yet can be waived. Void an invoice in Books instead.");
  const out = await new TenantRepo(store, ctx.tenantId).update("fee_instalments", String(row.ROWID), { status: "WAIVED", status_note: note });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "fee:waived", metadata: { fee_id: String(row.ROWID), label: row.label, amount: toNum(row.amount), note } });
  return out;
}

/** Records that a paid security deposit was paid back. */
export async function refundDeposit(store: Store, ctx: TenantContext, project: Row, row: Row, refundedOn: string, note: string | null): Promise<Row> {
  if (row.kind !== "DEPOSIT" || row.status !== "PAID") throw new AppError("INVALID_TRANSITION", "Only a paid security deposit can be refunded.");
  const out = await new TenantRepo(store, ctx.tenantId).update("fee_instalments", String(row.ROWID), { status: "REFUNDED", refunded_on: refundedOn, status_note: note });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "fee:refunded", metadata: { fee_id: String(row.ROWID), amount: toNum(row.amount), refunded_on: refundedOn, note } });
  return out;
}

export const instalmentRef = (agreement: Row, row: Row) => `FEE-${agreement.agreement_code}-${row.seq}`;

/**
 * Raises a scheduled instalment as a Books invoice and sends it (found by reference first, so a
 * retry never makes a second one). The deposit carries no tax.
 */
export async function raiseInstalment(store: Store, ctx: TenantContext, books: ZohoBooksClient | null, project: Row, agreement: Row, row: Row, now: Date, auto = false): Promise<Row> {
  if (row.status !== "SCHEDULED") throw new AppError("INVALID_TRANSITION", "This instalment is already invoiced.");
  if (!books) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const franchisee = await booksCustomerFor(repo, books, project);
  const settings = onboardingSettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));
  const ref = instalmentRef(agreement, row);
  const deposit = row.kind === "DEPOSIT";
  const line = deposit
    ? { name: "Security deposit", description: `Refundable security deposit, agreement ${agreement.agreement_code}, store ${project.project_code}`, rate: toNum(row.amount), quantity: 1 }
    : { name: "Franchise fee", description: `${row.label}, agreement ${agreement.agreement_code}, store ${project.project_code}`, rate: toNum(row.amount), quantity: 1, ...(settings.books_tax_id ? { tax_id: settings.books_tax_id } : {}) };
  const invoice = await books.findInvoice(ref) ?? await books.createInvoice({ customer_id: String(franchisee.zoho_books_customer_id), reference_number: ref, date: now.toISOString().slice(0, 10), payment_terms: settings.books_payment_terms, line_items: [line] });
  let state: Row = {};
  try {
    const inv = await books.getInvoice(invoice.id);
    if (inv.status === "draft") await books.sendInvoice(invoice.id, settings.books_email_invoice && franchisee.email ? [String(franchisee.email)] : []);
    const after = inv.status === "draft" ? await books.getInvoice(invoice.id) : inv;
    state = { invoice_number: after.number, invoice_status: after.status, invoice_total: after.total, invoice_balance: after.balance, invoice_due_date: after.due_date ? after.due_date.slice(0, 10) : null };
  } catch (e) {
    // The invoice exists; its number and status arrive with the next sync.
    log("warn", "fee.invoice_state_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  const out = await repo.update("fee_instalments", String(row.ROWID), { status: "INVOICED", zoho_books_invoice_id: invoice.id, invoice_ref: ref, invoiced_on: now.toISOString().slice(0, 10), ...state });
  await logActivity(store, ctx, {
    entityType: "project", entityId: String(project.ROWID), action: "fee:invoiced",
    metadata: { fee_id: String(row.ROWID), label: row.label, kind: row.kind, amount: toNum(row.amount), invoice_number: state.invoice_number ?? null, due: state.invoice_due_date ?? null, auto },
  });
  return out;
}

/** Re-reads an invoiced instalment: its own invoice from Books, or the agreement's stored copy. */
export async function refreshInstalment(store: Store, ctx: TenantContext, books: ZohoBooksClient | null, row: Row, agreement: Row | null): Promise<Row> {
  if (row.status !== "INVOICED" || !row.zoho_books_invoice_id) return row;
  const repo = new TenantRepo(store, ctx.tenantId);
  if (adopted(row, agreement)) {
    const patch = fromAgreement(agreement!);
    const same = Object.entries(patch).every(([k, v]) => String(row[k] ?? "") === String(v ?? ""));
    return same ? row : repo.update("fee_instalments", String(row.ROWID), patch);
  }
  if (!books) return row;
  const inv = await books.getInvoice(String(row.zoho_books_invoice_id));
  const status = inv.status.toLowerCase();
  const paid = status === "paid" || (inv.total > 0 && inv.balance <= 0);
  const patch: Row = { invoice_number: inv.number, invoice_status: inv.status, invoice_total: inv.total, invoice_balance: inv.balance, invoice_due_date: inv.due_date ? inv.due_date.slice(0, 10) : null };
  if (paid) Object.assign(patch, { status: "PAID", paid_on: (inv.last_payment_date ?? new Date().toISOString()).slice(0, 10) });
  if (status === "void") Object.assign(patch, { status: "WAIVED", status_note: "Invoice voided in Books" });
  const out = await repo.update("fee_instalments", String(row.ROWID), patch);
  if (paid) await logActivity(store, ctx, { entityType: "project", entityId: String(row.project_id), action: "fee:instalment_paid", metadata: { fee_id: String(row.ROWID), label: row.label, kind: row.kind, amount: inv.total, invoice_number: inv.number } });
  return out;
}

/**
 * Daily, for every open store of the tenant: makes missing schedules, raises the instalments whose
 * trigger is met, and refreshes the unpaid ones. One failure never stops the rest.
 */
export async function syncTenantInstalments(store: Store, ctx: TenantContext, books: ZohoBooksClient, now: Date): Promise<{ raised: number; paid: number; failed: number }> {
  const out = { raised: 0, paid: 0, failed: 0 };
  const repo = new TenantRepo(store, ctx.tenantId);
  const today = now.toISOString().slice(0, 10);
  const projects = (await Promise.all(OPEN_PROJECT.map((s) => repo.findMany("franchise_projects", { status: s }, { limit: 300 })))).flat();
  for (const project of projects) {
    try {
      const agreement = await agreementFor(repo, project);
      const rows = await ensureSchedule(store, ctx, project, agreement);
      if (!agreement || !rows.length) continue;
      const tasks = rows.some((r) => r.status === "SCHEDULED" && r.raise_on === "TASK") ? await repo.findMany("opening_checklists", { project_id: String(project.ROWID) }, { limit: 300 }) : [];
      for (const r of rows) {
        if (r.status === "SCHEDULED" && dueState(r, project, tasks, today).due) {
          await raiseInstalment(store, ctx, books, project, agreement, r, now, true);
          out.raised++;
        } else if (r.status === "INVOICED" && (await refreshInstalment(store, ctx, books, r, agreement)).status === "PAID") out.paid++;
      }
    } catch (e) {
      out.failed++;
      log("warn", "fee.instalment_sync_failed", { tenant_id: ctx.tenantId, project_id: String(project.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}

/** Invoiced instalments past their due date with money still owed (not the signing invoice, which fees.ts chases). */
export function overdueInstalments(rows: Row[], agreements: Map<string, Row>, today: string): Row[] {
  return rows.filter((r) => r.status === "INVOICED" && r.invoice_due_date && String(r.invoice_due_date).slice(0, 10) < today && toNum(r.invoice_balance) > 0 && !adopted(r, agreements.get(String(r.agreement_id)) ?? null));
}

// ---- The franchisee's funding ----

export const LOAN_STATES = ["SELF_FUNDED", "PLANNED", "APPLIED", "SANCTIONED", "DISBURSING", "DISBURSED", "REJECTED"] as const;
const SECURED = ["SANCTIONED", "DISBURSING", "DISBURSED"];
interface Tranche { amount: number; date: string; note?: string | null }

export type FundingChange =
  | { action: "plan"; own_capital: number; loan_amount: number; lender?: string | null; notes?: string | null }
  | { action: "applied"; lender: string; applied_on: string; loan_ref?: string | null }
  | { action: "sanctioned"; sanctioned_on: string; sanctioned_amount: number; interest_pct?: number | null; tenure_months?: number | null; sanction_ref?: string | null }
  | { action: "rejected"; reason: string }
  | { action: "disbursed"; amount: number; disbursed_on: string; note?: string | null };

export async function fundingPlan(repo: TenantRepo, project: Row): Promise<Row | null> {
  return repo.findOne("funding_plans", { project_id: String(project.ROWID) });
}

/** Records a step of the franchisee's funding: the plan, the loan application, sanction or rejection, and each disbursement. */
export async function changeFunding(store: Store, ctx: TenantContext, project: Row, change: FundingChange, by: "PORTAL" | "STAFF"): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const plan = await fundingPlan(repo, project);
  const status = String(plan?.status ?? "");
  const need = (ok: boolean, msg: string) => { if (!ok) throw new AppError("INVALID_TRANSITION", msg); };
  let patch: Row;
  const meta: Record<string, unknown> = { by };
  switch (change.action) {
    case "plan": {
      const locked = SECURED.includes(status);
      need(!locked || toNum(plan!.loan_amount) === change.loan_amount, "The loan is sanctioned; only own capital can change now.");
      const next = locked || ["APPLIED", "REJECTED"].includes(status) ? status : change.loan_amount > 0 ? "PLANNED" : "SELF_FUNDED";
      patch = { own_capital: change.own_capital, loan_amount: change.loan_amount, status: change.loan_amount > 0 ? next : "SELF_FUNDED", ...(change.lender !== undefined ? { lender: change.lender } : {}), ...(change.notes !== undefined ? { notes: change.notes } : {}) };
      Object.assign(meta, { own_capital: change.own_capital, loan_amount: change.loan_amount });
      break;
    }
    case "applied":
      need(["PLANNED", "REJECTED"].includes(status), plan ? "The loan has already been applied for." : "Set the funding plan first.");
      patch = { status: "APPLIED", lender: change.lender, applied_on: change.applied_on, loan_ref: change.loan_ref ?? null, rejected_reason: null };
      Object.assign(meta, { lender: change.lender });
      break;
    case "sanctioned":
      need(status === "APPLIED", "Record the loan application first.");
      patch = { status: "SANCTIONED", sanctioned_on: change.sanctioned_on, sanctioned_amount: change.sanctioned_amount, interest_pct: change.interest_pct ?? null, tenure_months: change.tenure_months ?? null, ...(change.sanction_ref ? { sanction_ref: change.sanction_ref } : {}) };
      Object.assign(meta, { lender: plan!.lender, sanctioned_amount: change.sanctioned_amount, requested: toNum(plan!.loan_amount) });
      break;
    case "rejected":
      need(status === "APPLIED", "Only a loan that's been applied for can be rejected.");
      patch = { status: "REJECTED", rejected_reason: change.reason };
      Object.assign(meta, { lender: plan!.lender, reason: change.reason });
      break;
    case "disbursed": {
      need(["SANCTIONED", "DISBURSING"].includes(status), "Record the sanction first.");
      const tranches = parse<Tranche[]>(plan!.disbursements_json, []);
      const so_far = tranches.reduce((a, t) => a + t.amount, 0);
      const left = round2(toNum(plan!.sanctioned_amount) - so_far);
      if (change.amount > left + 0.005) throw new AppError("VALIDATION_FAILED", `Only ${left.toLocaleString("en-IN")} of the sanctioned loan is left to disburse.`, { amount: "more than the sanction left" });
      if (plan!.sanctioned_on && change.disbursed_on < String(plan!.sanctioned_on).slice(0, 10)) throw new AppError("VALIDATION_FAILED", "A disbursement can't be before the sanction.", { disbursed_on: "before the sanction" });
      tranches.push({ amount: round2(change.amount), date: change.disbursed_on, note: change.note ?? null });
      const total = round2(so_far + change.amount);
      patch = { status: total >= toNum(plan!.sanctioned_amount) - 0.005 ? "DISBURSED" : "DISBURSING", disbursements_json: JSON.stringify(tranches), disbursed_amount: total };
      Object.assign(meta, { lender: plan!.lender, amount: change.amount, total, sanctioned_amount: toNum(plan!.sanctioned_amount) });
      break;
    }
  }
  let row: Row;
  if (plan) row = await repo.update("funding_plans", String(plan.ROWID), patch);
  else {
    need(change.action === "plan", "Set the funding plan first.");
    try {
      row = await repo.insert("funding_plans", { ...patch, project_id: String(project.ROWID), franchisee_id: project.franchisee_id ?? null, plan_key: `${ctx.tenantId}:${project.ROWID}` });
    } catch (e) {
      if (e instanceof DuplicateKeyError) throw new AppError("INVALID_TRANSITION", "The plan was just saved. Refresh to see it.");
      throw e;
    }
  }
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: `loan:${change.action}`, metadata: meta });
  return row;
}

/** The plan with what it covers: secured is own capital plus a sanctioned loan; the gap is what the budget still lacks. */
export function fundingSummary(plan: Row | null, investment: number) {
  const own = toNum(plan?.own_capital), loan = toNum(plan?.loan_amount);
  const sanctioned = plan && SECURED.includes(String(plan.status)) ? toNum(plan.sanctioned_amount) : 0;
  const secured = round2(own + sanctioned);
  return {
    investment, own_capital: own, loan_amount: loan, sanctioned, disbursed: toNum(plan?.disbursed_amount), planned: round2(own + loan), secured,
    gap: round2(Math.max(0, investment - secured)), planned_gap: round2(Math.max(0, investment - own - loan)),
    secured_pct: investment > 0 ? Math.min(100, Math.round((secured / investment) * 100)) : null,
  };
}

/** A store's fees and funding in one view. */
export async function fundingFor(store: Store, ctx: TenantContext, project: Row, books: ZohoBooksClient | null, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const agreement = await agreementFor(repo, project);
  let rows = await ensureSchedule(store, ctx, project, agreement);
  // The signing invoice follows the agreement's copy; others are refreshed by the daily sync or on request.
  rows = await Promise.all(rows.map((r) => (adopted(r, agreement) ? refreshInstalment(store, ctx, books, r, agreement) : r)));
  const tasks = await repo.findMany("opening_checklists", { project_id: String(project.ROWID) }, { limit: 300 });
  const instalments = rows.map((r): Row => {
    const d = dueState(r, project, tasks, today);
    return { ...r, when: d.when, due_now: r.status === "SCHEDULED" && d.due, overdue: r.status === "INVOICED" && !!r.invoice_due_date && String(r.invoice_due_date).slice(0, 10) < today && toNum(r.invoice_balance) > 0, signing_invoice: adopted(r, agreement) };
  });
  const live = instalments.filter((r) => r.status !== "WAIVED");
  const sum = (f: (r: Row) => boolean, k = "amount") => round2(live.filter(f).reduce((a, r) => a + toNum(r[k]), 0));
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const budget = (await ensureBudget(store, ctx, project)).reduce((a, l) => a + toNum(l.budget), 0);
  const plan = await fundingPlan(repo, project);
  return {
    agreement: agreement ? { ROWID: agreement.ROWID, agreement_code: agreement.agreement_code } : null,
    franchise_fee: onboardingSettings(tenant).franchise_fee,
    instalments,
    totals: {
      fee: sum((r) => r.kind === "FEE"), deposit: sum((r) => r.kind === "DEPOSIT" && r.status !== "REFUNDED"),
      invoiced: sum((r) => r.status !== "SCHEDULED"), scheduled: sum((r) => r.status === "SCHEDULED"),
      outstanding: sum((r) => r.status === "INVOICED", "invoice_balance"), overdue: instalments.filter((r) => r.overdue).length,
      deposit_held: sum((r) => r.kind === "DEPOSIT" && r.status === "PAID"),
    },
    tasks: tasks.map((t) => ({ code: t.task_code, name: t.item, status: t.status })),
    plan: plan ? { ...plan, disbursements: parse<Tranche[]>(plan.disbursements_json, []) } : null,
    funding: fundingSummary(plan, budget),
  };
}
