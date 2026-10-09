import { ZohoCrmClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho CRM v8 adapter (spec §13). Record APIs wrap results as { data: [ { code, details } ] }.
// Updates pass trigger: [] so FOS's own writes never fire CRM workflow rules (and the lead webhook).
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
    checkWrite(await this.http.request<CrmWrite>("PUT", `${this.baseUrl}/Leads/${encodeURIComponent(id)}`, { data: [data], trigger: [] }), "lead update");
  }

  async createAccount(data: object): Promise<{ id: string }> {
    const d = checkWrite(await this.http.request<CrmWrite>("POST", `${this.baseUrl}/Accounts`, { data: [data] }), "account create");
    if (!d.id) throw new ProviderError("CRM account create returned no id", 502);
    return { id: d.id };
  }

  async updateAccount(id: string, data: object): Promise<void> {
    checkWrite(await this.http.request<CrmWrite>("PUT", `${this.baseUrl}/Accounts/${encodeURIComponent(id)}`, { data: [data], trigger: [] }), "account update");
  }

  async convertLead(id: string): Promise<{ accountId: string; contactId: string | null }> {
    const res = await this.http.request<{ data?: Array<{ status?: string; code?: string; message?: string; details?: { Accounts?: { id?: string } | string; Contacts?: { id?: string } | string } }> }>(
      "POST", `${this.baseUrl}/Leads/${encodeURIComponent(id)}/actions/convert`, { data: [{ overwrite: true, notify_lead_owner: false, notify_new_entity_owner: false }] });
    const row = res?.data?.[0];
    const ref = (v: { id?: string } | string | undefined) => (typeof v === "string" ? v : v?.id) ?? null;
    const accountId = ref(row?.details?.Accounts);
    if (!row || row.status !== "success" || !accountId) throw new ProviderError(`CRM lead convert failed: ${row?.code ?? "no response"} ${row?.message ?? ""}`.trim(), 400, false);
    return { accountId, contactId: ref(row.details?.Contacts) };
  }

  async attachFile(module: string, recordId: string, file: { name: string; type: string; data: Uint8Array }): Promise<{ id: string }> {
    const res = await this.http.upload<CrmWrite>(`${this.baseUrl}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Attachments`, file);
    const d = checkWrite(res, "attachment upload");
    if (!d.id) throw new ProviderError("CRM attachment upload returned no id", 502);
    return { id: d.id };
  }
}
