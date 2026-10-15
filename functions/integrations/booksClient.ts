import { BooksBill, BooksDay, BooksInvoiceState, BooksPaymentInput, ZohoBooksClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho Books v3 adapter (D-17). Every call is scoped by organization_id.

interface BooksInvoice { invoice_id?: string; invoice_number?: string; reference_number?: string; customer_id?: string; status?: string; total?: number; balance?: number; due_date?: string; last_payment_date?: string }
interface BooksBillRow { bill_id?: string; bill_number?: string; reference_number?: string; vendor_name?: string; date?: string; status?: string; total?: number; balance?: number }
interface BooksSaleRow { invoice_id?: string; creditnote_id?: string; date?: string; status?: string; total?: number; sub_total?: number; tax_total?: number; discount_total?: number; discount?: number }
interface BooksRes { payment?: { payment_id?: string; payment_number?: string }; bills?: BooksBillRow[]; organizations?: Array<{ organization_id?: string; name?: string }>; creditnotes?: BooksSaleRow[]; page_context?: { has_more_page?: boolean }; code?: number; message?: string; contact?: { contact_id?: string }; contacts?: Array<{ contact_id?: string; contact_name?: string; email?: string }>; invoice?: BooksInvoice; invoices?: BooksInvoice[] }

function check(res: BooksRes | undefined, what: string): BooksRes {
  if (!res || (res.code !== undefined && res.code !== 0)) throw new ProviderError(`Books ${what} failed: ${res?.code ?? "no response"} ${res?.message ?? ""}`.trim(), 400, false);
  return res;
}

export class HttpBooksClient implements ZohoBooksClient {
  constructor(private readonly http: ZohoHttp, private readonly baseUrl: string, private readonly organizationId: string) {}

  private url(path: string, query: Record<string, string> = {}): string {
    return `${this.baseUrl}${path}?${new URLSearchParams({ organization_id: this.organizationId, ...query })}`;
  }

  async findCustomer(name: string, email?: string) {
    if (email) {
      const res = check(await this.http.request<BooksRes>("GET", this.url("/contacts", { email, contact_type: "customer" })), "contact search");
      // Email and name must both match: a same-name customer with another email is a different
      // business, and two franchisees can share one contact email (a group owner, a test inbox).
      const hit = res.contacts?.find((c) => c.email?.toLowerCase() === email.toLowerCase() && sameName(c.contact_name, name) && c.contact_id);
      return hit ? { id: String(hit.contact_id) } : null;
    }
    const res = check(await this.http.request<BooksRes>("GET", this.url("/contacts", { contact_name: name, contact_type: "customer" })), "contact search");
    const hit = res.contacts?.find((c) => sameName(c.contact_name, name) && c.contact_id);
    return hit ? { id: String(hit.contact_id) } : null;
  }

  async createCustomer(data: { contact_name: string; company_name?: string; email?: string; phone?: string }) {
    const body = {
      contact_name: data.contact_name,
      contact_type: "customer",
      ...(data.company_name ? { company_name: data.company_name } : {}),
      ...(data.email || data.phone ? { contact_persons: [{ email: data.email, phone: data.phone, is_primary_contact: true }] } : {}),
    };
    const id = check(await this.http.request<BooksRes>("POST", this.url("/contacts"), body), "contact create").contact?.contact_id;
    if (!id) throw new ProviderError("Books contact create returned no id", 502);
    return { id: String(id) };
  }

  async findInvoice(referenceNumber: string) {
    const res = check(await this.http.request<BooksRes>("GET", this.url("/invoices", { reference_number: referenceNumber })), "invoice search");
    const hit = res.invoices?.find((i) => i.reference_number === referenceNumber && i.invoice_id);
    return hit ? { id: String(hit.invoice_id), customer_id: hit.customer_id ? String(hit.customer_id) : undefined, total: hit.total == null ? undefined : Number(hit.total), status: hit.status ? String(hit.status) : undefined } : null;
  }

  async createInvoice(data: { customer_id: string; reference_number: string; date?: string; payment_terms?: number; line_items: Array<{ name: string; description?: string; rate: number; quantity: number; tax_id?: string }> }) {
    const id = check(await this.http.request<BooksRes>("POST", this.url("/invoices"), data), "invoice create").invoice?.invoice_id;
    if (!id) throw new ProviderError("Books invoice create returned no id", 502);
    return { id: String(id) };
  }

  async sendInvoice(id: string, to: string[]): Promise<void> {
    const path = `/invoices/${encodeURIComponent(id)}`;
    if (to.length) check(await this.http.request<BooksRes>("POST", this.url(`${path}/email`), { to_mail_ids: to, send_from_org_email_id: true }), "invoice email");
    else check(await this.http.request<BooksRes>("POST", this.url(`${path}/status/sent`)), "invoice mark sent");
  }

  async getInvoice(id: string): Promise<BooksInvoiceState> {
    const inv = check(await this.http.request<BooksRes>("GET", this.url(`/invoices/${encodeURIComponent(id)}`)), "invoice read").invoice;
    if (!inv?.invoice_id) throw new ProviderError(`Books invoice ${id} not found`, 404, false);
    return { id: String(inv.invoice_id), number: String(inv.invoice_number ?? ""), status: String(inv.status ?? "unknown"), total: Number(inv.total ?? 0), balance: Number(inv.balance ?? 0), due_date: inv.due_date ?? null, last_payment_date: inv.last_payment_date || null, customer_id: inv.customer_id ? String(inv.customer_id) : undefined };
  }

  // Needs the ZohoBooks.bills.READ scope. search_text also matches bill numbers and vendor names,
  // so only bills whose reference number carries the text are kept.
  async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
    // Organisations are not scoped by organisation; the plain endpoint lists what the token can see.
    const res = check(await this.http.request<BooksRes>("GET", `${this.baseUrl}/organizations`), "organizations");
    return (res.organizations ?? []).filter((o) => o.organization_id).map((o) => ({ id: String(o.organization_id), name: String(o.name ?? o.organization_id) }));
  }

  /**
   * Sales per day: every invoice dated in the window that is not a draft or void (gross before tax,
   * with its discount and tax), less credit notes as returns. The list rows carry `total`; when Books
   * also sends `sub_total` and `tax_total` they are used, else tax is taken as zero and gross = total.
   */
  async dailySales(from: string, to: string, locationId?: string | null): Promise<BooksDay[]> {
    const days = new Map<string, BooksDay>();
    const at = (d: string) => days.get(d) ?? days.set(d, { day: d, gross_sales: 0, discounts: 0, returns: 0, tax: 0, transactions: 0 }).get(d)!;
    const loc: Record<string, string> = locationId ? { location_id: locationId } : {};
    for (const [path, key] of [["/invoices", "invoices"], ["/creditnotes", "creditnotes"]] as const) {
      for (let page = 1; page <= 50; page++) {
        const res = check(await this.http.request<BooksRes>("GET", this.url(path, { date_start: from, date_end: to, per_page: "200", page: String(page), ...loc })), `${key} by date`);
        for (const r of (res[key] ?? []) as BooksSaleRow[]) {
          const status = String(r.status ?? "").toLowerCase();
          if (!r.date || status === "draft" || status === "void") continue;
          const d = at(String(r.date).slice(0, 10));
          const total = Number(r.total ?? 0), tax = Number(r.tax_total ?? 0), sub = r.sub_total != null ? Number(r.sub_total) : total - tax;
          if (key === "invoices") { d.gross_sales += sub; d.tax += tax; d.discounts += Number(r.discount_total ?? r.discount ?? 0); d.transactions++; }
          else d.returns += sub;
        }
        if (!res.page_context?.has_more_page) break;
      }
    }
    return [...days.values()].map((d) => ({ ...d, gross_sales: round2(d.gross_sales), discounts: round2(d.discounts), returns: round2(d.returns), tax: round2(d.tax) })).sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Books applies the payment to the invoices named; the invoice balance then reads back lower on the next getInvoice. */
  async recordPayment(data: BooksPaymentInput): Promise<{ id: string; number?: string }> {
    const p = check(await this.http.request<BooksRes>("POST", this.url("/customerpayments"), data), "payment create").payment;
    if (!p?.payment_id) throw new ProviderError("Books payment create returned no id", 502);
    return { id: String(p.payment_id), number: p.payment_number ? String(p.payment_number) : undefined };
  }

  async listBills(text: string): Promise<BooksBill[]> {
    const out: BooksBill[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = check(await this.http.request<BooksRes>("GET", this.url("/bills", { search_text: text, per_page: "200", page: String(page), sort_column: "date", sort_order: "D" })), "bill search");
      for (const b of res.bills ?? []) {
        if (!b.bill_id || !String(b.reference_number ?? "").toUpperCase().includes(text.toUpperCase())) continue;
        out.push({ id: String(b.bill_id), number: String(b.bill_number ?? ""), reference: String(b.reference_number ?? ""), vendor: String(b.vendor_name ?? ""), date: b.date || null, status: String(b.status ?? "unknown"), total: Number(b.total ?? 0), balance: Number(b.balance ?? 0) });
      }
      if (!res.page_context?.has_more_page) break;
    }
    return out;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function sameName(a: unknown, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}
