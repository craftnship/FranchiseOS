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
import { runTwoWaySyncJob } from "../../functions/workflows/twoWaySync";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { QSR_PROJECT_TEMPLATE } from "../../database/seed/defaults";
import { newStore } from "./helpers";

type Body = { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
const router = buildRouter();
const sleep = async () => {};

function fakes(opts: { failTaskNumber?: number; failBooks?: number; failTaskUpdates?: boolean } = {}) {
  const rescheduled: string[] = [];
  const crmData: Record<"lead" | "account" | "contact", Record<string, unknown>> = { lead: {}, account: {}, contact: {} };
  const accountUpdates: Array<Record<string, unknown>> = [];
  const calls: Record<string, number> = { send: 0, account: 0, customer: 0, invoice: 0, project: 0, tasklist: 0, task: 0, leadUpdate: 0, accountUpdate: 0, attach: 0, invoiceSent: 0 };
  const invoices: Record<string, { status: string; to: string[] }> = {};
  let signStatus = "inprogress";
  let id = 0;
  let booksFailures = opts.failBooks ?? 0;
  const tasks: Array<{ id: string; status: string; closed: boolean }> = [];
  const sign: ZohoSignClient = {
    sendFromTemplate: async () => { calls.send++; return { id: String(9000 + calls.send) }; },
    getRequest: async (rid) => ({ id: rid, status: signStatus, completedAt: "2026-10-09T06:00:00.000Z" }),
    downloadSigned: async (rid) => ({ name: `${rid}.pdf`, type: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) }),
  };
  const crm: ZohoCrmClient = {
    getLead: async () => ({ ...crmData.lead }), getAccount: async () => ({ ...crmData.account }), getContact: async () => ({ ...crmData.contact }),
    updateLead: async () => { calls.leadUpdate++; },
    createAccount: async () => { calls.account++; return { id: "ACC" + ++id }; },
    updateAccount: async (_id, data) => { calls.accountUpdate++; accountUpdates.push(data as Record<string, unknown>); },
    convertLead: async () => { calls.account++; return { accountId: "ACC" + ++id, contactId: "CON" + id }; },
    attachFile: async () => { calls.attach++; return { id: "ATT" + ++id }; },
  };
  const books: ZohoBooksClient = {
    findCustomer: async () => null,
    createCustomer: async () => { calls.customer++; return { id: "CUS" + ++id }; },
    findInvoice: async () => null,
    createInvoice: async () => {
      if (booksFailures-- > 0) throw new ProviderError("Books down", 503);
      calls.invoice++;
      const iid = "INV" + ++id;
      invoices[iid] = { status: "draft", to: [] };
      return { id: iid };
    },
    sendInvoice: async (iid, to) => { calls.invoiceSent++; invoices[iid] = { status: "sent", to }; },
    getInvoice: async (iid) => ({ id: iid, number: "INV-1", status: invoices[iid]?.status ?? "draft", total: 250000, balance: invoices[iid]?.status === "paid" ? 0 : 250000, due_date: "2026-10-24", last_payment_date: invoices[iid]?.status === "paid" ? "2026-10-09" : null }),
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
    setTaskClosed: async (_p, tid, closed) => {
      if (opts.failTaskUpdates) throw new ProviderError("Projects down", 503);
      const t = tasks.find((x) => x.id === tid)!;
      t.closed = closed; t.status = closed ? "Closed" : "Open";
    },
    rescheduleTask: async (_p, tid, due) => { rescheduled.push(`${tid}:${due}`); },
  };
  const clients: ZohoClients = { crm, sign, books, projects };
  return { clients, calls, rescheduled, crmData, accountUpdates, tasks, invoices, setSignStatus: (s: string) => { signStatus = s; } };
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
  const call = async (ext: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, zoho: async () => f.clients });
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
    const ter = await s.store.insert("territories", { tenant_id: s.tid, territory_code: "TER-000001", tenant_code_key: `${s.tid}:TER-000001`, name: "Saket", status: "RESERVED" });
    await s.store.insert("territory_reservations", { tenant_id: s.tid, territory_id: ter.ROWID, application_id: s.app.ROWID, status: "ACTIVE", expires_at: "2026-01-01T00:00:00Z", active_lock_key: `${s.tid}:${ter.ROWID}` });
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
    // Going live follows the store opening; it can't be done by hand.
    expect((await s.call("mgr", "POST", `/applications/${s.app.ROWID}/transition`, { transition: "activate" })).error?.code).toBe("INVALID_TRANSITION");
    expect((await s.store.findOne("franchisees", { ROWID: s.fr.ROWID! }))!).toMatchObject({ zoho_account_id: expect.any(String), zoho_books_customer_id: expect.any(String) });
    expect((await s.store.findMany("franchise_projects", {}))[0]).toMatchObject({ project_code: "PROJ-000001", status: "PLANNING", site_id: "77" });
    // The reserved territory is now the franchisee's for good.
    expect((await s.store.findOne("territories", { ROWID: ter.ROWID! }))!.status).toBe("ALLOCATED");
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

describe("development test route", () => {
  const send = (s: Awaited<ReturnType<typeof setup>>, applicationId: string) => handleWebhook(
    { method: "POST", path: "/server/fos_webhooks/webhooks/test/agreement/STARK", headers: { "x-fos-webhook-secret": "s3cret" }, query: {}, body: { application_id: applicationId } },
    { store: s.store, crm: async () => s.clients.crm, zoho: async () => s.clients, sleep },
  );

  it("is off unless the tenant enables it", async () => {
    const s = await setup();
    expect((await send(s, String(s.app.ROWID))).status).toBe(404);
    expect(s.calls.send).toBe(0);
  });

  it("sends an agreement when enabled", async () => {
    const s = await setup({ test_routes_enabled: true });
    const res = await send(s, String(s.app.ROWID));
    expect(res.status).toBe(200);
    expect((res.body as Body).data).toMatchObject({ sent: true, agreement: { status: "SENT" } });
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
    expect(res.data.sync).toEqual({ checked: QSR_PROJECT_TEMPLATE.length, updated: QSR_PROJECT_TEMPLATE.length, missing: 0 }); // the first sync also records every Zoho status name
    const detail = await s.call("pm", "GET", `/projects/${project}`);
    expect(detail.data.checklist.find((r: any) => r.external_task_id === s.tasks[0].id).status).toBe("COMPLETED");
    expect(detail.data.checklist.find((r: any) => r.external_task_id === s.tasks[1].id).status).toBe("BLOCKED");

    // Zoho's other statuses come through as in progress, with their name kept for display.
    s.tasks[2].status = "To be Tested";
    await s.call("pm", "POST", `/projects/${project}/sync`);
    expect((await s.call("pm", "GET", `/projects/${project}`)).data.checklist.find((r: any) => r.external_task_id === s.tasks[2].id))
      .toMatchObject({ status: "IN_PROGRESS", external_status: "To be Tested" });
  });

  it("marks a task done or reopens it in Zoho first, so a sync agrees; owners and due dates follow", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const project = (await s.signCallback("9001")).data.result.project_id;
    const detail = (await s.call("pm", "GET", `/projects/${project}`)).data;
    const item = detail.checklist.find((r: any) => r.external_task_id === s.tasks[0].id);
    expect(detail.staff.map((p: any) => p.email)).toContain("pm@x.test");
    expect(detail.staff.map((p: any) => p.email)).not.toContain("pepper@x.test");
    const path = `/projects/${project}/checklist/${item.ROWID}`;

    const done = await s.call("pm", "PATCH", path, { done: true });
    expect(done.data).toMatchObject({ zoho: true, item: { status: "COMPLETED" } });
    expect(s.tasks[0].closed).toBe(true);
    await s.call("pm", "POST", `/projects/${project}/sync`);
    expect((await s.store.findOne("opening_checklists", { ROWID: String(item.ROWID) }))!.status).toBe("COMPLETED");

    expect((await s.call("pm", "PATCH", path, { done: false })).data.item.status).toBe("OPEN");
    expect(s.tasks[0].closed).toBe(false);

    const pm = detail.staff.find((p: any) => p.email === "pm@x.test");
    const moved = await s.call("pm", "PATCH", path, { owner_user_id: pm.ROWID, due_date: "2026-12-01" });
    expect(moved.data.item).toMatchObject({ owner_user_id: pm.ROWID, due_date: "2026-12-01" });
    expect(s.rescheduled).toEqual([`${s.tasks[0].id}:2026-12-01`]);
    expect((await s.call("pm", "GET", `/projects/${project}`)).data.checklist.find((r: any) => r.ROWID === item.ROWID).owner.email).toBe("pm@x.test");
    expect((await s.call("pm", "PATCH", path, { owner_user_id: "nobody" })).error?.fields).toEqual({ owner_user_id: "not an active staff member" });
    expect((await s.call("pm", "PATCH", path, {})).error?.code).toBe("VALIDATION_FAILED");
  });

  it("changes nothing in FOS when Zoho refuses to close the task", async () => {
    const s = await setup(undefined, { failTaskUpdates: true });
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const project = (await s.signCallback("9001")).data.result.project_id;
    const item = (await s.call("pm", "GET", `/projects/${project}`)).data.checklist[0];
    const res = await s.call("pm", "PATCH", `/projects/${project}/checklist/${item.ROWID}`, { done: true });
    expect(res.error?.code).toBe("ZOHO_SYNC_FAILED");
    expect((await s.store.findOne("opening_checklists", { ROWID: String(item.ROWID) }))!.status).toBe(item.status);
  });

  it("maps task states", () => {
    expect(checklistStatus({ closed: true }, "BLOCKED")).toBe("COMPLETED");
    expect(checklistStatus({ closed: false, percent: 30 }, "OPEN")).toBe("IN_PROGRESS");
    expect(checklistStatus({ closed: false, status: "Open" }, "COMPLETED")).toBe("OPEN");
    expect(checklistStatus({ closed: false, status: "Open" }, "OPEN")).toBe("OPEN");
    expect(checklistStatus({ closed: false, status: "In Progress" }, "OPEN")).toBe("IN_PROGRESS");
    expect(checklistStatus({ closed: false, status: "Delayed" }, "OPEN")).toBe("IN_PROGRESS");
    expect(checklistStatus({ closed: false, status: "To be Tested" }, "BLOCKED")).toBe("BLOCKED");
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

  it("Books: reuses a customer only when both email and name match", async () => {
    const contacts = { code: 0, contacts: [{ contact_id: "C1", contact_name: "New Lead", email: "shared@x.test" }, { contact_id: "C2", contact_name: "Malhotra Foods", email: "shared@x.test" }] };
    const { http } = recorder([contacts, contacts]);
    const books = new HttpBooksClient(http, "https://www.zohoapis.in/books/v3", "600");
    expect(await books.findCustomer("malhotra foods", "Shared@x.test")).toEqual({ id: "C2" });
    expect(await books.findCustomer("Kapoor Foods", "shared@x.test")).toBeNull();
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

  it("Projects: closes tasks by the configured status and moves both dates when rescheduling", async () => {
    const { http, sent } = recorder([{}, { tasks: [{ id: "T1", start_date: "2026-10-23T15:59:59.000Z", end_date: "2026-10-24T15:59:59.000Z" }] }, {}]);
    const projects = new HttpProjectsClient(http, "https://projectsapi.zoho.in/api/v3", "42", "Z1", { closed: "188" });
    await projects.setTaskClosed("P1", "T1", true);
    expect(sent[0]).toMatchObject({ method: "PATCH", url: "https://projectsapi.zoho.in/api/v3/portal/42/projects/P1/tasks/T1" });
    expect(JSON.parse(sent[0].body!)).toEqual({ status: { id: "188" } });
    await expect(projects.setTaskClosed("P1", "T1", false)).rejects.toThrow("projects_open_status_id");
    await projects.rescheduleTask("P1", "T1", "2026-10-20");
    expect(JSON.parse(sent[2].body!)).toEqual({ start_date: "2026-10-19T15:59:59Z", end_date: "2026-10-20T15:59:59Z" });
  });
});

describe("Phase A: close the lifecycle loop", () => {
  const sign = async (s: Awaited<ReturnType<typeof setup>>) => {
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    return s.signCallback("9001");
  };

  it("signing activates the franchisee, converts the lead, files the signed PDF and sends the invoice once", async () => {
    const s = await setup();
    await s.store.update("franchisees", String(s.fr.ROWID), { zoho_lead_id: "L1" });
    const res = await sign(s);
    expect(res.data.result).toMatchObject({ zoho_contact_id: expect.stringMatching(/^CON/), document_ref: expect.stringMatching(/^crm:Accounts\/ACC\d+\/Attachments\/ATT\d+$/), pending: [] });
    expect((await s.store.findOne("franchisees", { ROWID: s.fr.ROWID! }))!).toMatchObject({ status: "ACTIVE", zoho_contact_id: expect.stringMatching(/^CON/) });
    const agreement = (await s.store.findOne("agreements", { zoho_sign_request_id: "9001" }))!;
    expect(s.invoices[String(agreement.zoho_books_invoice_id)]).toEqual({ status: "sent", to: ["p@x.test"] });

    // A manual retry finishes nothing twice.
    await s.call("mgr", "POST", `/agreements/${agreement.ROWID}/onboard`);
    expect(s.calls).toMatchObject({ account: 1, attach: 1, invoice: 1, invoiceSent: 1 });
  });

  it("opening the store makes the application and the franchisee ACTIVE", async () => {
    const s = await setup();
    await sign(s);
    const t = await s.store.findOne("tenants", { tenant_code: "STARK" });
    const roles = await s.store.findMany("roles", { tenant_id: String(t!.ROWID) });
    await s.store.insert("users", { tenant_id: String(t!.ROWID), email: "boss@x.test", status: "ACTIVE", role_id: String(roles.find((r) => r.code === "SUPER_ADMIN")!.ROWID), external_user_id: "boss" });
    // The franchisee is set back to PROSPECT to show opening activates it too.
    await s.store.update("franchisees", String(s.fr.ROWID), { status: "PROSPECT" });
    const project = (await s.store.findMany("franchise_projects", {}))[0];
    await s.store.update("franchise_projects", String(project.ROWID), { status: "READY_FOR_OPENING" });
    // Signing created the licence register; mark them issued so the opening isn't blocked.
    for (const l of await s.store.findMany("licences", { project_id: String(project.ROWID) })) await s.store.update("licences", String(l.ROWID), { status: "ISSUED", issued_on: "2026-09-01" });
    const updatesBefore = s.calls.accountUpdate;

    const res = await s.call("boss", "POST", `/projects/${project.ROWID}/transition`, { transition: "open", actual_opening_date: "2026-10-09" });
    expect(res.data).toMatchObject({ status: "OPENED", activation: { application_status: "ACTIVE", franchisee_status: "ACTIVE" } });
    expect((await s.store.findOne("franchise_applications", { ROWID: s.app.ROWID! }))!.status).toBe("ACTIVE");
    expect(s.calls.accountUpdate).toBeGreaterThan(updatesBefore);
  });

  it("the project page shows the franchise fee and whether it is paid, without blocking work", async () => {
    const s = await setup();
    await sign(s);
    const project = (await s.store.findMany("franchise_projects", {}))[0];
    const unpaid = await s.call("pm", "GET", `/projects/${project.ROWID}`);
    expect(unpaid.data.fee).toMatchObject({ status: "SENT", paid: false, balance: 250000 });
    expect(unpaid.data.allowed_transitions).toContain("start");

    const agreement = (await s.store.findOne("agreements", { zoho_sign_request_id: "9001" }))!;
    s.invoices[String(agreement.zoho_books_invoice_id)].status = "paid";
    expect((await s.call("pm", "GET", `/projects/${project.ROWID}`)).data.fee).toMatchObject({ status: "PAID", paid: true, paid_on: "2026-10-09" });
  });

  it("Books payments come back: the agreement records the paid date, CRM is told, the dashboard counts it", async () => {
    const s = await setup();
    await sign(s);
    const agreement = (await s.store.findOne("agreements", { zoho_sign_request_id: "9001" }))!;
    // Nothing checked yet: the job picks the fee up as unsettled.
    const job = () => runTwoWaySyncJob(s.store, async () => s.clients, { now: new Date("2026-10-12T05:00:00Z"), requestId: "REQ-job" });
    expect(await job()).toMatchObject({ tenants: 1, fees_checked: 1, fees_paid: 0 });
    let dash = (await s.call("mgr", "GET", "/dashboard/network")).data;
    expect(dash).toMatchObject({ fees_collected: { value: 0 }, fees_outstanding: { value: 250000 } });

    s.invoices[String(agreement.zoho_books_invoice_id)].status = "paid";
    const updatesBefore = s.accountUpdates.length;
    const synced = await s.call("mgr", "POST", "/fees/sync");
    expect(synced.data).toMatchObject({ checked: 1, changed: 1, paid: 1, failed: 0 });
    expect(await s.store.findOne("agreements", { ROWID: String(agreement.ROWID) })).toMatchObject({ fee_status: "PAID", fee_balance: 0, fee_paid_on: "2026-10-09" });
    expect(s.accountUpdates.slice(updatesBefore)).toEqual([{ FOS_Fee_Status: "PAID", FOS_Fee_Paid_On: "2026-10-09" }]);
    expect(await s.store.findMany("activity_logs", { entity_id: String(agreement.ROWID), action: "fee:paid" })).toHaveLength(1);

    dash = (await s.call("mgr", "GET", "/dashboard/network")).data;
    expect(dash).toMatchObject({ fees_collected: { value: 250000, drill: { path: "/agreements" } }, fees_outstanding: { value: 0 } });
    expect((await s.call("mgr", "GET", "/agreements", undefined, { fee_status: "PAID" })).data).toHaveLength(1);
    // Settled fees are no longer checked.
    expect(await job()).toMatchObject({ fees_checked: 0 });
  });

  it("CRM edits come back onto the franchisee, without blanking what FOS has", async () => {
    const s = await setup();
    await sign(s);
    // Signing converted the lead into an Account and Contact.
    await s.store.update("franchisees", String(s.fr.ROWID), { zoho_contact_id: "CON1" });
    const before = (await s.store.findOne("franchisees", { ROWID: String(s.fr.ROWID) }))!;
    s.crmData.contact = { Full_Name: "Pepper Potts-Stark", Email: "pepper.new@x.test", Mobile: "", Phone: "+91 98400 11111" };
    s.crmData.account = { Account_Name: "Potts Foods Pvt Ltd" };
    const res = await s.call("mgr", "POST", `/franchisees/${s.fr.ROWID}/sync-crm`);
    expect(res.data.changed.sort()).toEqual(["display_name", "email", "legal_name", "phone"]);
    expect(res.data.franchisee).toMatchObject({ display_name: "Pepper Potts-Stark", email: "pepper.new@x.test", phone: "+91 98400 11111", legal_name: "Potts Foods Pvt Ltd" });
    expect(before.email).not.toBe("pepper.new@x.test");
    s.crmData.contact = { Email: "" };
    expect((await s.call("mgr", "POST", `/franchisees/${s.fr.ROWID}/sync-crm`)).data.changed).toEqual([]);
    expect(await s.store.findMany("activity_logs", { entity_id: String(s.fr.ROWID), action: "update:crm" })).toHaveLength(1);
  });

  it("checks the Zoho Sign signature when a Sign secret is configured", async () => {
    const s = await setup();
    await s.call("mgr", "POST", `/applications/${s.app.ROWID}/agreement`);
    s.setSignStatus("completed");
    const { createHmac } = await import("crypto");
    const body = { requests: { request_id: "9001" }, notifications: { operation_type: "RequestCompleted" } };
    const raw = JSON.stringify(body);
    const post = (sig?: string) => handleWebhook(
      { method: "POST", path: "/webhooks/sign/STARK", headers: sig ? { "x-zs-webhook-signature": sig } : {}, query: { token: "s3cret" }, body, rawBody: raw },
      { store: s.store, crm: async () => s.clients.crm, zoho: async () => s.clients, sleep, signSecret: "sign-key" },
    );
    expect(((await post()).body as Body).error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(((await post("bad")).body as Body).error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    const good = await post(createHmac("sha256", "sign-key").update(raw).digest("base64"));
    expect((good.body as Body).data?.action).toBe("onboarded");
  });
});
