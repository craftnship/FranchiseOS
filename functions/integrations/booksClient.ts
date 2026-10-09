import { BooksInvoiceState, ZohoBooksClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho Books v3 adapter (D-17). Every call is scoped by organization_id.

interface BooksInvoice { invoice_id?: string; invoice_number?: string; reference_number?: string; status?: string; total?: number; balance?: number; due_date?: string }
interface BooksRes { code?: number; message?: string; contact?: { contact_id?: string }; contacts?: Array<{ contact_id?: string; contact_name?: string; email?: string }>; invoice?: BooksInvoice; invoices?: BooksInvoice[] }

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
      const hit = res.contacts?.find((c) => c.email?.toLowerCase() === email.toLowerCase() && c.contact_id);
      // With an email, a same-name customer with another email is a different business.
      return hit ? { id: String(hit.contact_id) } : null;
    }
    const res = check(await this.http.request<BooksRes>("GET", this.url("/contacts", { contact_name: name, contact_type: "customer" })), "contact search");
    const hit = res.contacts?.find((c) => c.contact_name === name && c.contact_id);
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
    return hit ? { id: String(hit.invoice_id) } : null;
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
    return { id: String(inv.invoice_id), number: String(inv.invoice_number ?? ""), status: String(inv.status ?? "unknown"), total: Number(inv.total ?? 0), balance: Number(inv.balance ?? 0), due_date: inv.due_date ?? null };
  }
}
