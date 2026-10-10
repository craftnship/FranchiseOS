import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { log } from "../common/logger";
import { Row, Store, TenantRepo } from "../common/store";
import { BooksInvoiceState, ZohoBooksClient, ZohoCrmClient } from "../integrations/clients";
import { CRM_ACCOUNT_FIELDS } from "../integrations/crmSync";

// Franchise fee payments, Books → FOS (two-way sync). Books owns the invoice; FOS keeps a copy of
// its state on the agreement so lists and dashboards need no Books call, and records the day it was
// paid. The franchisee's CRM Account gets the fee status and paid date.

/** FOS fee states: Books' invoice status, with paid settled by the balance. */
export type FeeStatus = "DRAFT" | "SENT" | "VIEWED" | "OVERDUE" | "PARTIALLY_PAID" | "PAID" | "VOID";

export function feeStatusOf(inv: Pick<BooksInvoiceState, "status" | "balance" | "total">): FeeStatus {
  const s = inv.status.toLowerCase();
  if (s === "void") return "VOID";
  if (s === "paid" || (inv.total > 0 && inv.balance <= 0)) return "PAID";
  if (s === "partially_paid" || (inv.balance > 0 && inv.balance < inv.total)) return "PARTIALLY_PAID";
  if (s === "overdue") return "OVERDUE";
  if (s === "viewed") return "VIEWED";
  if (s === "draft") return "DRAFT";
  return "SENT";
}

/** Fee states the sync still watches; PAID and VOID are final. */
export const OPEN_FEE_STATES = ["DRAFT", "SENT", "VIEWED", "OVERDUE", "PARTIALLY_PAID"];

export interface FeeRefresh { agreement: Row; changed: boolean; paid_now: boolean; invoice: BooksInvoiceState }

/**
 * Reads the agreement's fee invoice from Books and stores its state. The first time it reads as
 * paid, the paid date is recorded, the activity log notes it, and the CRM Account is updated (a CRM
 * failure is logged and retried by the next sync, since the CRM fields follow the stored status).
 */
export async function refreshFee(
  store: Store, ctx: TenantContext, books: ZohoBooksClient, crm: ZohoCrmClient | null, agreement: Row, now: Date,
): Promise<FeeRefresh> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const invoice = await books.getInvoice(String(agreement.zoho_books_invoice_id));
  const status = feeStatusOf(invoice);
  const paidNow = status === "PAID" && agreement.fee_status !== "PAID";
  const paidOn = status === "PAID" ? String(agreement.fee_paid_on ?? "").slice(0, 10) || (invoice.last_payment_date ?? now.toISOString()).slice(0, 10) : null;
  const patch: Row = {
    fee_status: status, fee_total: invoice.total, fee_balance: invoice.balance, fee_due_date: invoice.due_date ? invoice.due_date.slice(0, 10) : null,
    fee_paid_on: paidOn, fee_checked_at: now.toISOString(),
  };
  const changed = status !== agreement.fee_status || Number(agreement.fee_balance ?? NaN) !== invoice.balance;
  // Page loads refresh too, so an unchanged fee is rewritten at most every 10 minutes.
  const fresh = agreement.fee_checked_at && now.getTime() - Date.parse(String(agreement.fee_checked_at)) < 600_000;
  const updated = changed || !fresh ? await repo.update("agreements", String(agreement.ROWID), patch) : agreement;
  if (changed) {
    await logActivity(store, ctx, { entityType: "agreement", entityId: String(agreement.ROWID), action: paidNow ? "fee:paid" : "fee:status", metadata: { status, balance: invoice.balance, paid_on: paidOn, invoice: invoice.number } });
  }
  if (changed && crm) {
    const franchisee = await repo.findOne("franchisees", { ROWID: String(agreement.franchisee_id) });
    if (franchisee?.zoho_account_id) {
      await crm.updateAccount(String(franchisee.zoho_account_id), { [CRM_ACCOUNT_FIELDS.feeStatus]: status, [CRM_ACCOUNT_FIELDS.feePaidOn]: paidOn })
        .catch((e) => log("warn", "crm.fee_push_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, agreement_id: String(agreement.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) }));
    }
  }
  return { agreement: updated, changed, paid_now: paidNow, invoice };
}

/** Signed agreements whose fee is not settled yet (an unchecked one has no fee_status). */
export async function unsettledFees(repo: TenantRepo): Promise<Row[]> {
  const signed = await repo.findMany("agreements", { status: "SIGNED" }, { limit: 300 });
  return signed.filter((a) => a.zoho_books_invoice_id && !["PAID", "VOID"].includes(String(a.fee_status ?? "")));
}

/** Refreshes every unsettled fee of one tenant; one failure never stops the rest. */
export async function syncTenantFees(store: Store, ctx: TenantContext, books: ZohoBooksClient, crm: ZohoCrmClient | null, now: Date) {
  const out = { checked: 0, changed: 0, paid: 0, failed: 0 };
  for (const a of await unsettledFees(new TenantRepo(store, ctx.tenantId))) {
    out.checked++;
    try {
      const r = await refreshFee(store, ctx, books, crm, a, now);
      if (r.changed) out.changed++;
      if (r.paid_now) out.paid++;
    } catch (e) {
      out.failed++;
      log("warn", "fee.sync_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, agreement_id: String(a.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}
