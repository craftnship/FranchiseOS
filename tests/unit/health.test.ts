import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { ZohoCrmClient } from "../../functions/integrations/clients";
import { eventKey } from "../../functions/integrations/idempotency";
import { handleCrmLead } from "../../functions/webhooks/crmLead";
import { recordJobRun } from "../../functions/workflows/systemAlerts";
import { newStore } from "./helpers";

const router = buildRouter();
const lead = { id: "L1", Full_Name: "Pepper Potts", Email: "p@x.test", Lead_Status: "Pre-Qualified", Modified_Time: "2026-10-08T10:00:00+05:30" };
const crmClient = (failing: boolean): ZohoCrmClient => ({
  getLead: async () => ({ ...lead }), getAccount: async () => ({}), getContact: async () => ({}), createAccount: async () => ({ id: "A1" }),
  updateAccount: async () => {}, convertLead: async () => ({ accountId: "A1", contactId: "C1" }), attachFile: async () => ({ id: "F1" }),
  updateLead: async () => { if (failing) throw new Error("INVALID_TOKEN"); },
});

async function setup() {
  const store = newStore();
  const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = a.tenantId;
  await store.insert("users", { tenant_id: tid, email: "tony@x.test", name: "Tony", status: "ACTIVE", role_id: a.roleIds.SUPER_ADMIN, external_user_id: "tony" });
  await store.insert("users", { tenant_id: tid, email: "pm@x.test", status: "ACTIVE", role_id: a.roleIds.PROJECT_MANAGER, external_user_id: "pm" });
  const crm = { current: crmClient(false) };
  const call = async (ext: string, method: string, path: string, body?: unknown, now?: string) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, zoho: async () => ({ crm: crm.current } as any), ...(now ? { now: () => new Date(now) } : {}) });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  const sys = { tenantId: tid, userId: "SYSTEM:crm", roles: ["SYSTEM"], zohoDc: "IN", requestId: "R1", correlationId: "R1" };
  const inbox = async (ext: string) => ((await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[]).filter((t) => t.includes("failed"));
  return { store, tid, call, crm, sys, inbox };
}

describe("integration health", () => {
  it("alerts super admins to a dead letter once, and retrying it clears it", async () => {
    const s = await setup();
    await handleCrmLead(s.store, s.sys, crmClient(true), { leadId: "L1", sleep: async () => {} });
    expect(await s.inbox("tony")).toEqual(["CRM update failed: lead.status"]);
    expect(await s.inbox("pm")).toEqual([]);
    const h = await s.call("tony", "GET", "/admin/integrations");
    expect(h.data.problems).toMatchObject([{ kind: "log", source: "CRM", what: "Push status to CRM lead", error: "INVALID_TOKEN", attempts: 4, subject: { label: "APP-000001" }, retryable: true }]);
    expect(h.data.sources).toEqual([{ source: "CRM", ok: 1, failed: 1, retried: 3 }]);
    s.crm.current = crmClient(true);
    expect((await s.call("tony", "POST", "/admin/integrations/retry", { kind: "log", id: h.data.problems[0].id })).error?.code).toBe("ZOHO_SYNC_FAILED");
    // The failed retry replaces the item with its own dead letter.
    const again = (await s.call("tony", "GET", "/admin/integrations")).data.problems;
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(h.data.problems[0].id);
    s.crm.current = crmClient(false);
    expect((await s.call("tony", "POST", "/admin/integrations/retry", { kind: "log", id: again[0].id })).data.retried).toBe(true);
    expect((await s.call("tony", "GET", "/admin/integrations")).data.problems).toEqual([]);
    expect((await s.call("tony", "POST", "/admin/integrations/retry", { kind: "log", id: again[0].id })).error?.code).toBe("INVALID_TRANSITION");
  });

  it("replays a failed CRM lead event", async () => {
    const s = await setup();
    const ev = await s.store.insert("integration_events", { tenant_id: s.tid, source_system: "CRM", event_id: `lead:${lead.Modified_Time}`, record_id: "L1", event_key: eventKey("CRM", `lead:${lead.Modified_Time}`, "L1"), status: "FAILED", payload_json: "{}", error_message: "timeout" });
    const h = await s.call("tony", "GET", "/admin/integrations");
    expect(h.data.problems).toMatchObject([{ kind: "event", what: "Lead webhook", subject: { label: "CRM lead L1" }, retryable: true }]);
    const r = await s.call("tony", "POST", "/admin/integrations/retry", { kind: "event", id: String(ev.ROWID) });
    expect(r.data.outcome).toMatchObject({ action: "created", application_code: "APP-000001" });
    expect(await s.store.findOne("integration_events", { ROWID: String(ev.ROWID) })).toMatchObject({ status: "PROCESSED" });
  });

  it("lists an event a dead function left in flight, and lets it be retried", async () => {
    const s = await setup();
    const ev = await s.store.insert("integration_events", { tenant_id: s.tid, source_system: "CRM", event_id: `lead:${lead.Modified_Time}`, record_id: "L1", event_key: eventKey("CRM", `lead:${lead.Modified_Time}`, "L1"), status: "PROCESSING", payload_json: "{}" });
    // Just started: in flight, not a problem.
    expect((await s.call("tony", "GET", "/admin/integrations")).data.problems).toEqual([]);
    // Twenty minutes on, still PROCESSING: it was cut off.
    const later = new Date(Date.now() + 20 * 60_000).toISOString();
    const h = (await s.call("tony", "GET", "/admin/integrations", undefined, later)).data;
    expect(h.problems).toMatchObject([{ kind: "event", what: "Lead webhook", error: expect.stringContaining("cut off"), retryable: true }]);
    const r = await s.call("tony", "POST", "/admin/integrations/retry", { kind: "event", id: String(ev.ROWID) }, later);
    expect(r.data.outcome).toMatchObject({ action: "created" });
    expect(await s.store.findOne("integration_events", { ROWID: String(ev.ROWID) })).toMatchObject({ status: "PROCESSED" });
  });

  it("resolves an item with a reason, for super admins only", async () => {
    const s = await setup();
    const ev = await s.store.insert("integration_events", { tenant_id: s.tid, source_system: "CRM", record_id: "L9", event_key: "k", status: "FAILED", error_message: "x" });
    expect((await s.call("pm", "GET", "/admin/integrations")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("tony", "POST", "/admin/integrations/resolve", { kind: "event", id: String(ev.ROWID) })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("tony", "POST", "/admin/integrations/resolve", { kind: "event", id: String(ev.ROWID), reason: "Lead deleted in CRM" })).data.resolved).toBe(true);
    expect((await s.call("tony", "GET", "/admin/integrations")).data.problems).toEqual([]);
    expect((await s.call("tony", "GET", "/audit")).data.items[0]).toMatchObject({ action: "integration:resolved", details: { reason: "Lead deleted in CRM" } });
  });

  it("records each daily job step and alerts when one fails", async () => {
    const s = await setup();
    const now = new Date("2026-10-11T00:30:00Z");
    await recordJobRun(s.store, { step: "project_risk", ok: true, requestId: "J1", now });
    await recordJobRun(s.store, { step: "two_way_sync", ok: false, error: "Books down", requestId: "J1", now });
    await recordJobRun(s.store, { step: "two_way_sync", ok: false, error: "Books down", requestId: "J2", now });
    const jobs = (await s.call("tony", "GET", "/admin/integrations")).data.jobs;
    expect(jobs.find((j: any) => j.step === "project_risk")).toMatchObject({ ok: true });
    expect(jobs.find((j: any) => j.step === "two_way_sync")).toMatchObject({ ok: false, error: "Books down", last_success: null });
    expect(jobs.find((j: any) => j.step === "reminders")).toMatchObject({ ok: null, last_run: null });
    expect(await s.inbox("tony")).toEqual(["Daily job failed: Books payments and CRM edits"]);
    // A busy night of Zoho calls after the first step does not push its run off the screen.
    for (let i = 0; i < 400; i++) await s.store.insert("integration_logs", { tenant_id: s.tid, source_system: "BOOKS", entity_type: "invoice", entity_id: `I${i}`, operation: "create", status: "SUCCESS", attempt: 1, request_id: "J3" });
    const later = (await s.call("tony", "GET", "/admin/integrations")).data.jobs;
    expect(later.find((j: any) => j.step === "project_risk")).toMatchObject({ ok: true, last_run: expect.any(String) });
  });
});
