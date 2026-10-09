import { TenantContext } from "../common/context";
import { log } from "../common/logger";
import { Store } from "../common/store";
import { ZohoCrmClient } from "./clients";
import { withRetry } from "./retry";

// CRM Lead write-back (plan Step 2.2). Field API names were created on Leads on 2026-10-08.
export const CRM_LEAD_FIELDS = {
  applicationCode: "FOS_Application_Code",
  applicationStatus: "FOS_Application_Status",
  investmentCapacity: "Investment_Capacity",
  franchiseType: "Franchise_Type",
  preferredCity: "Preferred_City",
  preferredState: "Preferred_State",
} as const;

/** FOS fields on CRM Accounts, created 2026-10-09 for Phase A. The lead is converted on signing. */
export const CRM_ACCOUNT_FIELDS = {
  franchiseCode: "FOS_Franchise_Code",
  applicationCode: "FOS_Application_Code",
  applicationStatus: "FOS_Application_Status",
  targetOpening: "FOS_Target_Opening",
  openedOn: "FOS_Opened_On",
} as const;

export type CrmFactory = (tenantId: string) => Promise<ZohoCrmClient | null>;

/**
 * Pushes an application's code and status to CRM: to its Account once the franchisee has one, and
 * to its lead while the lead is not converted. Failures are retried and land in integration_logs
 * as DEAD_LETTER; they never fail the user's action.
 */
export async function pushApplicationStatus(
  store: Store,
  ctx: Pick<TenantContext, "tenantId" | "requestId">,
  crm: ZohoCrmClient | null,
  app: Record<string, unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (!crm) return false;
  const franchisee = app.franchisee_id ? await store.findOne("franchisees", { tenant_id: ctx.tenantId, ROWID: String(app.franchisee_id) }) : null;
  const accountId = franchisee?.zoho_account_id ? String(franchisee.zoho_account_id) : null;
  // A converted lead (the franchisee has a CRM Contact) no longer takes updates.
  const leadId = app.zoho_lead_id && !franchisee?.zoho_contact_id ? String(app.zoho_lead_id) : null;
  if (!accountId && !leadId) return false;
  const meta = { store, tenantId: ctx.tenantId, sourceSystem: "CRM", entityType: "application", entityId: String(app.ROWID), requestId: ctx.requestId };
  try {
    if (accountId) {
      await withRetry(() => crm.updateAccount(accountId, {
        [CRM_ACCOUNT_FIELDS.applicationCode]: app.application_code,
        [CRM_ACCOUNT_FIELDS.applicationStatus]: app.status,
      }), { ...meta, operation: "account.status" }, { sleep: opts.sleep });
    }
    if (leadId) {
      await withRetry(() => crm.updateLead(leadId, {
        [CRM_LEAD_FIELDS.applicationCode]: app.application_code,
        [CRM_LEAD_FIELDS.applicationStatus]: app.status,
      }), { ...meta, operation: "lead.status" }, { sleep: opts.sleep });
    }
    return true;
  } catch (e) {
    log("warn", "crm.status_push_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error).message) });
    return false;
  }
}
