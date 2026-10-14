import { AppError } from "../common/errors";
import { Row } from "../common/store";
import { BooksInvoiceRef } from "../integrations/clients";

// Invoices raised in Zoho Books are found again by their reference number, so a retry never raises a
// second one. Two rules keep that lookup honest, learned on 2026-10-14 when a store's royalty was
// attached to an older pilot's invoice that happened to carry the same reference.

/** A reference that cannot collide across tenants, or across a re-seeded pilot, on one Books organisation: KIND-TENANT-… */
export const booksRef = (tenant: Row | null, kind: string, ...parts: Array<string | number>): string => [kind, String(tenant?.tenant_code ?? "FOS"), ...parts].join("-");

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * An invoice found by reference is adopted only when it is plainly ours: the same Books customer and,
 * unless Books adds tax on top of the lines, the same total. Anything else stops with INVOICE_CONFLICT,
 * so a stray invoice is never attached to a report, fee or instalment. A voided invoice is ignored and a
 * fresh one raised. A client that returns neither customer nor total is trusted as before.
 */
export function adoptInvoice(found: BooksInvoiceRef | null, want: { customer_id: string; total: number; taxed: boolean; ref: string }): BooksInvoiceRef | null {
  if (!found || found.status === "void") return null;
  if (found.customer_id && String(found.customer_id) !== String(want.customer_id)) {
    throw new AppError("INVOICE_CONFLICT", `Zoho Books already has an invoice with reference ${want.ref} for another customer. Void or renumber it in Books, then try again.`, { reference: "another customer's invoice" });
  }
  const off = found.total == null ? 0 : want.taxed ? Math.max(0, want.total - found.total) : Math.abs(found.total - want.total);
  if (off > 0.01) {
    throw new AppError("INVOICE_CONFLICT", `Zoho Books already has an invoice with reference ${want.ref} for ${money(found.total!)}, not ${money(want.total)}. Void it in Books, then try again.`, { reference: "different amount" });
  }
  return found;
}
