import { ZohoBooksClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho Books v3 adapter (D-17). Every call is scoped by organization_id.

interface BooksRes { code?: number; message?: string; contact?: { contact_id?: string }; contacts?: Array<{ contact_id?: string; contact_name?: string }>; invoice?: { invoice_id?: string }; invoices?: Array<{ invoice_id?: string; reference_number?: string }> }

function check(res: BooksRes | undefined, what: string): BooksRes {
  if (!res || (res.code !== undefined && res.code !== 0)) throw new ProviderError(`Books ${what} failed: ${res?.code ?? "no response"} ${res?.message ?? ""}`.trim(), 400, false);
  return res;
}

export class HttpBooksClient implements ZohoBooksClient {
  constructor(private readonly http: ZohoHttp, private readonly baseUrl: string, private readonly organizationId: string) {}

  private url(path: string, query: Record<string, string> = {}): string {
    return `${this.baseUrl}${path}?${new URLSearchParams({ organization_id: this.organizationId, ...query })}`;
  }

  async findCustomer(name: string) {
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

  async createInvoice(data: { customer_id: string; reference_number: string; date?: string; line_items: Array<{ name: string; description?: string; rate: number; quantity: number }> }) {
    const id = check(await this.http.request<BooksRes>("POST", this.url("/invoices"), data), "invoice create").invoice?.invoice_id;
    if (!id) throw new ProviderError("Books invoice create returned no id", 502);
    return { id: String(id) };
  }
}
