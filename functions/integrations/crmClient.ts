import { ZohoCrmClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho CRM v8 adapter (spec §13). Record APIs wrap results as { data: [ { code, details } ] }.
interface CrmRecords { data?: Array<Record<string, unknown>> }
interface CrmWrite { data?: Array<{ code: string; status: string; message?: string; details?: { id?: string } }> }

function first(res: CrmRecords | undefined, what: string): Record<string, unknown> {
  const rec = res?.data?.[0];
  if (!rec) throw new ProviderError(`CRM ${what} not found`, 404, false);
  return rec;
}

function checkWrite(res: CrmWrite | undefined, what: string): { id?: string } {
  const row = res?.data?.[0];
  if (!row || row.status !== "success") throw new ProviderError(`CRM ${what} failed: ${row?.code ?? "no response"} ${row?.message ?? ""}`.trim(), 400, false);
  return row.details ?? {};
}

export class HttpCrmClient implements ZohoCrmClient {
  constructor(private readonly http: ZohoHttp, private readonly baseUrl: string) {}

  async getLead(id: string) { return first(await this.http.request<CrmRecords>("GET", `${this.baseUrl}/Leads/${encodeURIComponent(id)}`), "lead"); }
  async getAccount(id: string) { return first(await this.http.request<CrmRecords>("GET", `${this.baseUrl}/Accounts/${encodeURIComponent(id)}`), "account"); }
  async getContact(id: string) { return first(await this.http.request<CrmRecords>("GET", `${this.baseUrl}/Contacts/${encodeURIComponent(id)}`), "contact"); }

  async updateLead(id: string, data: object): Promise<void> {
    checkWrite(await this.http.request<CrmWrite>("PUT", `${this.baseUrl}/Leads/${encodeURIComponent(id)}`, { data: [data] }), "lead update");
  }

  async createAccount(data: object): Promise<{ id: string }> {
    const d = checkWrite(await this.http.request<CrmWrite>("POST", `${this.baseUrl}/Accounts`, { data: [data] }), "account create");
    if (!d.id) throw new ProviderError("CRM account create returned no id", 502);
    return { id: d.id };
  }
}
