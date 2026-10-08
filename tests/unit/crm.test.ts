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
