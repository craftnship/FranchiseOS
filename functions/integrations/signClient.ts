import { SignRecipient, SignRequestState, ZohoSignClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho Sign v1 adapter (spec §13, FOS-045). A request is created from a Sign template and sent in
// one call (is_quicksend). The template's first SIGN action is assigned to the franchisee.

interface SignTemplate { templates?: { actions?: Array<{ action_id?: string; action_type?: string }> } }
interface SignRequestRes { requests?: { request_id?: string | number; request_status?: string; action_time?: string | number } }

export class HttpSignClient implements ZohoSignClient {
  constructor(private readonly http: ZohoHttp, private readonly baseUrl: string) {}

  async sendFromTemplate(templateId: string, data: { requestName: string; recipient: SignRecipient; fieldData?: Record<string, string> }): Promise<{ id: string }> {
    const tpl = await this.http.request<SignTemplate>("GET", `${this.baseUrl}/templates/${encodeURIComponent(templateId)}`);
    const action = tpl?.templates?.actions?.find((a) => (a.action_type ?? "SIGN").toUpperCase() === "SIGN");
    if (!action?.action_id) throw new ProviderError(`Sign template ${templateId} has no signer role`, 400, false);
    const payload = {
      templates: {
        request_name: data.requestName,
        field_data: { field_text_data: data.fieldData ?? {} },
        actions: [{ action_id: action.action_id, action_type: "SIGN", recipient_name: data.recipient.name, recipient_email: data.recipient.email, verify_recipient: false }],
      },
    };
    const res = await this.http.requestForm<SignRequestRes>("POST", `${this.baseUrl}/templates/${encodeURIComponent(templateId)}/createdocument`, {
      data: JSON.stringify(payload), is_quicksend: "true",
    });
    const id = res?.requests?.request_id;
    if (!id) throw new ProviderError("Sign request create returned no id", 502);
    return { id: String(id) };
  }

  async getRequest(id: string): Promise<SignRequestState> {
    const res = await this.http.request<SignRequestRes>("GET", `${this.baseUrl}/requests/${encodeURIComponent(id)}`);
    const r = res?.requests;
    if (!r?.request_status) throw new ProviderError(`Sign request ${id} not found`, 404, false);
    const t = r.action_time;
    return { id: String(r.request_id ?? id), status: String(r.request_status).toLowerCase(), ...(t ? { completedAt: new Date(Number(t) || String(t)).toISOString() } : {}) };
  }
}
