import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { ZohoBooksClient, ZohoCrmClient, ZohoProjectsClient, ZohoSignClient } from "../../functions/integrations/clients";
import { HttpBooksClient } from "../../functions/integrations/booksClient";
import { HttpProjectsClient } from "../../functions/integrations/projectsClient";
import { ProviderError } from "../../functions/integrations/retry";
import { HttpSignClient } from "../../functions/integrations/signClient";
import { ZohoClients } from "../../functions/integrations/tenantClients";
import { FetchLike, ZohoHttp } from "../../functions/integrations/zohoHttp";
import { handleWebhook } from "../../functions/webhooks/router";
import { checklistStatus } from "../../functions/workflows/projectSync";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { QSR_PROJECT_TEMPLATE } from "../../database/seed/defaults";
import { newStore } from "./helpers";

type Body = { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
const router = buildRouter();
const sleep = async () => {};

function fakes(opts: { failTaskNumber?: number; failBooks?: number } = {}) {
  const calls: Record<string, number> = { send: 0, account: 0, customer: 0, invoice: 0, project: 0, tasklist: 0, task: 0, leadUpdate: 0 };
  let signStatus = "inprogress";
  let id = 0;
  let booksFailures = opts.failBooks ?? 0;
  const tasks: Array<{ id: string; status: string; closed: boolean }> = [];
  const sign: ZohoSignClient = {
    sendFromTemplate: async () => { calls.send++; return { id: String(9000 + calls.send) }; },
    getRequest: async (rid) => ({ id: rid, status: signStatus, completedAt: "2026-10-09T06:00:00.000Z" }),
  };
  const crm: ZohoCrmClient = {
    getLead: async () => ({}), getAccount: async () => ({}), getContact: async () => ({}),
    updateLead: async () => { calls.leadUpdate++; },
    createAccount: async () => { calls.account++; return { id: "ACC" + ++id }; },
  };
  const books: ZohoBooksClient = {
    findCustomer: async () => null,
    createCustomer: async () => { calls.customer++; return { id: "CUS" + ++id }; },
    findInvoice: async () => null,
    createInvoice: async () => {
      if (booksFailures-- > 0) throw new ProviderError("Books down", 503);
      calls.invoice++; return { id: "INV" + ++id };
    },
  };
  const projects: ZohoProjectsClient = {
    createProject: async () => { calls.project++; return { id: "ZP" + ++id }; },
    getProject: async (pid) => ({ id: pid }),
    createTaskList: async () => { calls.tasklist++; return { id: "TL" + ++id }; },
    createTask: async () => {
      calls.task++;
      if (opts.failTaskNumber && calls.task === opts.failTaskNumber) throw new ProviderError("timeout", 504);
      const t = { id: "TK" + ++id, status: "Open", closed: false };
      tasks.push(t);
      return { id: t.id };
    },
    updateTask: async () => {},
    addDependency: async () => { throw new Error("not used"); },
    listTasks: async () => tasks.map((t) => ({ ...t })),
  };
  const clients: ZohoClients = { crm, sign, books, projects };
  return { clients, calls, tasks, setSignStatus: (s: string) => { signStatus = s; } };
}

async function setup(settings: Record<string, unknown> = { franchise_fee: 250000 }, fakeOpts: Parameters<typeof fakes>[0] = {}) {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const tenant = (await store.findOne("tenants", { ROWID: tid }))!;
  await store.update("tenants", tid, { settings_json: JSON.stringify({ ...JSON.parse(String(tenant.settings_json)), ...settings }) });
  const tpl = (await store.findOne("agreement_templates", { tenant_id: tid }))!;
  await store.update("agreement_templates", String(tpl.ROWID), { zoho_sign_template_id: "TPL1" });
  await store.insert("tenant_integrations", { tenant_id: tid, provider: "ZOHO", zoho_dc: "IN", status: "ACTIVE", webhook_secret: "s3cret", provider_key: `${tid}:ZOHO` });
  await store.insert("users", { tenant_id: tid, email: "mgr@x.test", status: "ACTIVE", role_id: t.roleIds.FRANCHISE_MANAGER, external_user_id: "mgr" });
  await store.insert("users", { tenant_id: tid, email: "pm@x.test", status: "ACTIVE", role_id: t.roleIds.PROJECT_MANAGER, external_user_id: "pm" });
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", legal_name: "Potts Foods LLP", email: "p@x.test", status: "PROSPECT", franchise_type: "QSR" });
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "APPROVED", site_id: "77", zoho_lead_id: "L1" });
  const f = fakes(fakeOpts);
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, zoho: async () => f.clients });
    return { status: res.status, ...(res.body as Body) };
  };
  const signCallback = async (requestId: string, operation = "RequestCompleted", token = "s3cret") => {
    const res = await handleWebhook(
      { method: "POST", path: "/server/fos_webhooks/webhooks/sign/STARK", headers: {}, query: { token }, body: { requests: { request_id: requestId }, notifications: { operation_type: operation } } },
      { store, crm: async () => f.clients.crm, zoho: async () => f.clients, sleep },
    );
    return { status: res.status, ...(res.body as Body) };
  };
  return { store, tid, app, fr, call, signCallback, ...f };
}

describe("send agreement (FOS-045, FOS-046)", () => {
  it("creates the agreement, sends it through Sign once and moves the application on", async () => {
    const s = await setup();
    const res = await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ sent: true, agreement: { agreement_code: "AGR-000001", status: "SENT", zoho_sign_request_id: "9001" } });
    expect((await s.store.findOne("franchise_applications", { ROWID: s.app.ROWID! }))!.status).toBe("AGREEMENT_PENDING");

    const again = await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    expect(again.data).toMatchObject({ sent: false, agreement: { agreement_code: "AGR-000001" } });
    expect(s.calls.send).toBe(1);
  });

  it("needs the Sign template id and the agreement.write permission", async () => {
    const s = await setup();
    expect((await s.call("pm", "POST", `/applications/${s.app.ROWID}/agreement`)).error?.code).toBe("ACCESS_DENIED");
    const tpl = (await s.store.findOne("agreement_templates", { tenant_id: s.tid }))!;
    await s.store.update("agreement_templates", String(tpl.ROWID), { zoho_sign_template_id: null });
    const res = await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    expect(res.status).toBe(422);
    expect(res.error?.fields).toEqual({ zoho_sign_template_id: "required" });
    expect(await s.store.findMany("agreements", {})).toHaveLength(0);
  });

  it("refuses applications that are not approved", async () => {
    const s = await setup();
    await s.store.update("franchise_applications", String(s.app.ROWID), { status: "UNDER_REVIEW" });
    expect((await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`)).error?.code).toBe("APPLICATION_INVALID_STATE");
  });
});

describe("Sign callback and onboarding (Step 5 exit test)", () => {
  it("a signed callback replayed three times creates exactly one project with all tasks", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const results = [await s.signCallback("9001"), await s.signCallback("9001"), await s.signCallback("9001")];
    expect(results.map((r) => r.data?.action)).toEqual(["onboarded", "duplicate", "duplicate"]);
    expect(results[0].data.result).toMatchObject({ zoho_account_id: expect.any(String), zoho_books_invoice_id: expect.any(String), zoho_project_id: expect.any(String), tasks_created: QSR_PROJECT_TEMPLATE.length, pending: [] });

    expect(await s.store.findMany("franchise_projects", {})).toHaveLength(1);
    expect(await s.store.findMany("opening_checklists", {})).toHaveLength(QSR_PROJECT_TEMPLATE.length);
    expect(s.calls).toMatchObject({ project: 1, task: QSR_PROJECT_TEMPLATE.length, account: 1, customer: 1, invoice: 1 });

    const agreement = (await s.store.findOne("agreements", { zoho_sign_request_id: "9001" }))!;
    expect(agreement).toMatchObject({ status: "SIGNED", effective_date: "2026-10-09", expiry_date: "2031-10-08" });
    expect((await s.store.findOne("franchise_applications", { ROWID: s.app.ROWID! }))!.status).toBe("ONBOARDING");
    expect((await s.store.findOne("franchisees", { ROWID: s.fr.ROWID! }))!).toMatchObject({ zoho_account_id: expect.any(String), zoho_books_customer_id: expect.any(String) });
    expect((await s.store.findMany("franchise_projects", {}))[0]).toMatchObject({ project_code: "PROJ-000001", status: "PLANNING", site_id: "77" });
  });

  it("a run killed half way is finished by the retry, on the same project", async () => {
    const s = await setup({ franchise_fee: 250000 }, { failTaskNumber: 5 });
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const first = await s.signCallback("9001");
    expect(first.status).toBe(502);
    expect(first.error?.code).toBe("ZOHO_SYNC_FAILED");
    expect((await s.store.findMany("integration_events", { source_system: "SIGN" }))[0].status).toBe("FAILED");

    const second = await s.signCallback("9001");
    expect(second.data).toMatchObject({ action: "onboarded", result: { pending: [], tasks_created: QSR_PROJECT_TEMPLATE.length - 4 } });
    expect(s.calls.project).toBe(1);
    expect(s.calls.task).toBe(QSR_PROJECT_TEMPLATE.length + 1); // one failed call, nothing duplicated
    expect(s.calls.invoice).toBe(1);
    expect(await s.store.findMany("franchise_projects", {})).toHaveLength(1);
    expect((await s.signCallback("9001")).data.action).toBe("duplicate");
  });

  it("a Books outage does not block the project, and the onboard retry finishes the invoice", async () => {
    const s = await setup({ franchise_fee: 250000 }, { failBooks: 1 });
    const sent = await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    expect((await s.signCallback("9001")).status).toBe(502);
    expect(s.calls.project).toBe(1);
    const retry = await s.call("mgr", "POST", `/agreements/${sent.data.agreement.ROWID}/onboard`);
    expect(retry.data).toMatchObject({ pending: [], zoho_books_invoice_id: expect.any(String) });
    expect(s.calls).toMatchObject({ project: 1, invoice: 1, customer: 1 });
  });

  it("skips the invoice when no franchise fee is set", async () => {
    const s = await setup({});
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    expect((await s.signCallback("9001")).data.result).toMatchObject({ zoho_books_invoice_id: null, pending: [] });
    expect(s.calls.invoice).toBe(0);
  });

  it("trusts Sign's status, not the callback: an unsigned request changes nothing", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    const res = await s.signCallback("9001", "RequestCompleted");
    expect(res.data.action).toBe("ignored");
    expect((await s.store.findOne("agreements", { zoho_sign_request_id: "9001" }))!.status).toBe("SENT");
    expect(await s.store.findMany("franchise_projects", {})).toHaveLength(0);
  });

  it("rejects a callback without the tenant secret", async () => {
    const s = await setup();
    expect((await s.signCallback("9001", "RequestCompleted", "wrong")).error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });

  it("records a decline and allows a resend", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("declined");
    expect((await s.signCallback("9001", "RequestRejected")).data).toMatchObject({ action: "updated", status: "DECLINED" });
    const resend = await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    expect(resend.data).toMatchObject({ sent: true, agreement: { agreement_code: "AGR-000002", zoho_sign_request_id: "9002" } });
  });
});

describe("project task sync (FOS-057)", () => {
  it("mirrors Zoho task progress into the opening checklist", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const project = (await s.signCallback("9001")).data.result.project_id;
    s.tasks[0].closed = true;
    const rows = await s.store.findMany("opening_checklists", {});
    await s.store.update("opening_checklists", String(rows.find((r) => r.external_task_id === s.tasks[1].id)!.ROWID), { status: "BLOCKED" });
    const res = await s.call("pm", "POST", `/projects/${project}/sync`);
    expect(res.data).toEqual({ checked: QSR_PROJECT_TEMPLATE.length, updated: 1, missing: 0 });
    const detail = await s.call("pm", "GET", `/projects/${project}`);
    expect(detail.data.checklist.find((r: any) => r.external_task_id === s.tasks[0].id).status).toBe("COMPLETED");
    expect(detail.data.checklist.find((r: any) => r.external_task_id === s.tasks[1].id).status).toBe("BLOCKED");
  });

  it("maps task states", () => {
    expect(checklistStatus({ closed: true }, "BLOCKED")).toBe("COMPLETED");
    expect(checklistStatus({ closed: false, percent: 30 }, "OPEN")).toBe("IN_PROGRESS");
    expect(checklistStatus({ closed: false }, "COMPLETED")).toBe("IN_PROGRESS");
    expect(checklistStatus({ closed: false }, "OPEN")).toBe("OPEN");
  });
});

describe("Zoho adapters", () => {
  function recorder(responses: unknown[]) {
    const sent: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      sent.push({ url, ...init });
      const data = responses.shift() ?? {};
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
    };
    return { http: new ZohoHttp({ accessToken: async () => "tok" }, fetchFn), sent };
  }

  it("Sign: sends a template request form-encoded to the template's signer", async () => {
    const { http, sent } = recorder([{ templates: { actions: [{ action_id: "A9", action_type: "SIGN" }] } }, { requests: { request_id: 555 } }]);
    const ref = await new HttpSignClient(http, "https://sign.zoho.in/api/v1").sendFromTemplate("1234", { requestName: "AGR-1", recipient: { name: "P", email: "p@x.test" } });
    expect(ref).toEqual({ id: "555" });
    expect(sent[1].url).toBe("https://sign.zoho.in/api/v1/templates/1234/createdocument");
    expect(sent[1].headers!["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent[1].body);
    expect(form.get("is_quicksend")).toBe("true");
    expect(JSON.parse(form.get("data")!).templates.actions[0]).toMatchObject({ action_id: "A9", recipient_email: "p@x.test" });
  });

  it("Sign: looks a template up by name", async () => {
    const { http, sent } = recorder([{ templates: [{ template_id: 77, template_name: "Other" }, { template_id: 88, template_name: "Franchise_Agreement" }] }, { templates: { actions: [{ action_id: "A1" }] } }, { requests: { request_id: 1 } }]);
    await new HttpSignClient(http, "https://sign.zoho.in/api/v1").sendFromTemplate("Franchise_Agreement", { requestName: "AGR-1", recipient: { name: "P", email: "p@x.test" } });
    expect(sent[1].url).toBe("https://sign.zoho.in/api/v1/templates/88");
    expect(sent[2].url).toBe("https://sign.zoho.in/api/v1/templates/88/createdocument");
  });

  it("Books: scopes calls by organization and raises Books error codes", async () => {
    const { http, sent } = recorder([{ code: 0, invoice: { invoice_id: "I1" } }, { code: 1002, message: "Invalid customer" }]);
    const books = new HttpBooksClient(http, "https://www.zohoapis.in/books/v3", "600");
    expect(await books.createInvoice({ customer_id: "C1", reference_number: "AGR-1", line_items: [{ name: "Fee", rate: 1, quantity: 1 }] })).toEqual({ id: "I1" });
    expect(sent[0].url).toBe("https://www.zohoapis.in/books/v3/invoices?organization_id=600");
    await expect(books.createCustomer({ contact_name: "X" })).rejects.toThrow("1002 Invalid customer");
  });

  it("Projects: creates tasks in a task list and reads ids from V3 responses", async () => {
    const { http, sent } = recorder([{ id: "P1" }, { tasks: [{ id: "T1" }] }]);
    const projects = new HttpProjectsClient(http, "https://projectsapi.zoho.in/api/v3", "42", "Z1");
    expect(await projects.createProject({ name: "PROJ-1 Opening" })).toEqual({ id: "P1" });
    expect(JSON.parse(sent[0].body!).owner).toEqual({ zpuid: "Z1" });
    expect(await projects.createTask("P1", { name: "Lease", tasklist_id: "L1", end_date: "2026-11-01" })).toEqual({ id: "T1" });
    expect(sent[1].url).toBe("https://projectsapi.zoho.in/api/v3/portal/42/projects/P1/tasks");
    expect(JSON.parse(sent[1].body!)).toEqual({ name: "Lease", end_date: "2026-11-01", tasklist: { id: "L1" } });
  });
});
