import { describe, expect, it } from "vitest";
import { ZohoCrmClient } from "../../functions/integrations/clients";
import { handleCrmLead } from "../../functions/webhooks/crmLead";
import { ctx, newStore } from "./helpers";

function fakeCrm(lead: Record<string, unknown>, failUpdates = 0) {
  const updates: Array<{ id: string; data: any }> = [];
  let failures = failUpdates;
  const crm: ZohoCrmClient = {
    getLead: async () => ({ ...lead }),
    getAccount: async () => ({}),
    getContact: async () => ({}),
    createAccount: async () => ({ id: "A1" }),
    updateAccount: async () => {},
    convertLead: async () => ({ accountId: "A1", contactId: "C1" }),
    attachFile: async () => ({ id: "F1" }),
    updateLead: async (id, data) => {
      if (failures-- > 0) throw new Error("boom");
      updates.push({ id, data });
    },
  };
  return { crm, updates };
}

const lead = { id: "L1", Full_Name: "Pepper Potts", Email: "p@x.test", Lead_Status: "Pre-Qualified", Modified_Time: "2026-10-08T10:00:00+05:30", Preferred_City: "Chennai", Investment_Capacity: 5000000 };
const sleep = async () => {};

describe("CRM lead webhook (D-9)", () => {
  it("does not create an application for a lead with no email or phone, and flags it in CRM", async () => {
    const store = newStore();
    const { crm, updates } = fakeCrm({ ...lead, Email: null, Mobile: null, Phone: null });
    const res = await handleCrmLead(store, ctx(["SYSTEM"]), crm, { leadId: "L1", sleep });
    expect(res).toMatchObject({ action: "ignored" });
    expect(updates).toEqual([{ id: "L1", data: { FOS_Application_Status: "NEEDS_CONTACT_DETAILS" } }]);
    expect(await store.findMany("franchise_applications", {})).toHaveLength(0);
  });

  it("creates franchisee and DRAFT application once and writes status back", async () => {
    const store = newStore();
    const { crm, updates } = fakeCrm(lead);
    const first = await handleCrmLead(store, ctx(["SYSTEM"]), crm, { leadId: "L1", sleep });
    expect(first).toMatchObject({ action: "created", application_code: "APP-000001", crm_updated: true });
    expect(updates[0]).toEqual({ id: "L1", data: { FOS_Application_Code: "APP-000001", FOS_Application_Status: "DRAFT" } });
    const app = await store.findOne("franchise_applications", { zoho_lead_id: "L1" });
    expect(app).toMatchObject({ status: "DRAFT", preferred_city: "Chennai", investment_capacity: 5000000 });

    expect((await handleCrmLead(store, ctx(["SYSTEM"]), crm, { leadId: "L1", sleep })).action).toBe("duplicate");
    expect(await store.findMany("franchise_applications", {})).toHaveLength(1);
  });

  it("reuses the open application on a later lead edit", async () => {
    const store = newStore();
    await handleCrmLead(store, ctx(["SYSTEM"]), fakeCrm(lead).crm, { leadId: "L1", sleep });
    const again = await handleCrmLead(store, ctx(["SYSTEM"]), fakeCrm({ ...lead, Modified_Time: "later" }).crm, { leadId: "L1", sleep });
    expect(again.action).toBe("existing");
    expect(await store.findMany("franchisees", {})).toHaveLength(1);
  });

  it("ignores leads not at the trigger status", async () => {
    const store = newStore();
    const res = await handleCrmLead(store, ctx(["SYSTEM"]), fakeCrm({ ...lead, Lead_Status: "Contacted" }).crm, { leadId: "L1", sleep });
    expect(res.action).toBe("ignored");
    expect(await store.findMany("franchisees", {})).toHaveLength(0);
  });

  it("keeps the application when the CRM write-back fails and logs a dead letter", async () => {
    const store = newStore();
    const res = await handleCrmLead(store, ctx(["SYSTEM"]), fakeCrm(lead, 10).crm, { leadId: "L1", sleep });
    expect(res).toMatchObject({ action: "created", crm_updated: false });
    const logs = await store.findMany("integration_logs", { status: "DEAD_LETTER" });
    expect(logs).toHaveLength(1);
  });
});

describe("CRM webhook endpoint", () => {
  async function setup() {
    const { bootstrapTenant } = await import("../../database/seed/bootstrapTenant");
    const { handleWebhook } = await import("../../functions/webhooks/router");
    const store = newStore();
    const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    await store.insert("tenant_integrations", { tenant_id: t.tenantId, provider: "ZOHO", zoho_dc: "IN", status: "ACTIVE", webhook_secret: "s3cret", refresh_token: "r", provider_key: `${t.tenantId}:ZOHO` });
    const { crm } = fakeCrm({ ...lead, id: "123" });
    const hit = (path: string, headers: Record<string, string>, body: unknown) =>
      handleWebhook({ method: "POST", path, headers, query: {}, body }, { store, crm: async () => crm, sleep });
    return { store, hit };
  }

  it("accepts the secret as a token in the form body", async () => {
    const { hit } = await setup();
    const res = await hit("/webhooks/crm/lead/STARK", {}, { lead_id: "x", token: "s3cret" });
    expect(res.status).toBe(422);
    expect((await hit("/webhooks/crm/lead/STARK", {}, { lead_id: "1", token: "nope" })).status).toBe(401);
  });

  it("reports a Zoho failure as ZOHO_SYNC_FAILED with Zoho's reason", async () => {
    const { ProviderError } = await import("../../functions/integrations/retry");
    const { store } = await setup();
    const { handleWebhook } = await import("../../functions/webhooks/router");
    const broken = { getLead: async () => { throw new ProviderError("Zoho token refresh failed: invalid_client", 401, false); } };
    const res = await handleWebhook({ method: "POST", path: "/webhooks/crm/lead/STARK", headers: { "x-fos-webhook-secret": "s3cret" }, query: {}, body: { lead_id: "123" } },
      { store, crm: async () => broken as never, sleep });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).toContain("invalid_client");
  });

  it("rejects a wrong secret and an unknown tenant the same way", async () => {
    const { hit } = await setup();
    expect((await hit("/webhooks/crm/lead/STARK", { "x-fos-webhook-secret": "nope" }, { lead_id: "123" })).status).toBe(401);
    expect((await hit("/webhooks/crm/lead/NOPE", { "x-fos-webhook-secret": "s3cret" }, { lead_id: "123" })).status).toBe(401);
    expect((await hit("/webhooks/crm/lead/STARK", {}, { lead_id: "123" })).status).toBe(401);
  });

  it("validates the lead id and processes a good call", async () => {
    const { hit, store } = await setup();
    expect((await hit("/webhooks/crm/lead/STARK", { "x-fos-webhook-secret": "s3cret" }, { lead_id: "x' OR 1=1" })).status).toBe(422);
    const ok = await hit("/server/fos_webhooks/webhooks/crm/lead/stark", { "x-fos-webhook-secret": "s3cret" }, { lead_id: "123" });
    expect(ok.status).toBe(200);
    expect((ok.body as any).data.action).toBe("created");
    expect(await store.findMany("franchise_applications", { zoho_lead_id: "123" })).toHaveLength(1);
  });
});

describe("pilot env fallbacks", () => {
  it("uses the env refresh token and webhook secret when the integration row has none", async () => {
    const { crmFactory } = await import("../../functions/integrations/tenantClients");
    const { handleWebhook } = await import("../../functions/webhooks/router");
    const store = newStore();
    const t = await store.insert("tenants", { tenant_code: "STARK", name: "Stark", status: "ACTIVE", zoho_dc: "IN" });
    await store.insert("tenant_integrations", { tenant_id: String(t.ROWID), provider: "ZOHO", zoho_dc: "IN", status: "ACTIVE", provider_key: "k" });
    const factory = crmFactory(store, { clientId: "c", clientSecret: "s" }, undefined, { ZOHO_REFRESH_TOKEN: "r" } as NodeJS.ProcessEnv);
    expect(await factory(String(t.ROWID))).not.toBeNull();
    expect(await crmFactory(store, { clientId: "c", clientSecret: "s" }, undefined, {} as NodeJS.ProcessEnv)(String(t.ROWID))).toBeNull();
    const res = await handleWebhook({ method: "POST", path: "/webhooks/crm/lead/STARK", headers: { "x-fos-webhook-secret": "wrong" }, query: {}, body: { lead_id: "1" } },
      { store, crm: async () => null, fallbackSecret: "envsecret" });
    expect(res.status).toBe(401);
    const res2 = await handleWebhook({ method: "POST", path: "/webhooks/crm/lead/STARK", headers: { "x-fos-webhook-secret": "envsecret" }, query: {}, body: { lead_id: "1" } },
      { store, crm: async () => null, fallbackSecret: "envsecret" });
    expect((res2.body as any).error.code).toBe("ZOHO_SYNC_FAILED");
  });
});
