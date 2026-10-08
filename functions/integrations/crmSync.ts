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

export type CrmFactory = (tenantId: string) => Promise<ZohoCrmClient | null>;

/**
 * Pushes an application's code and status to its CRM lead. Failures are retried and land in
 * integration_logs as DEAD_LETTER; they never fail the user's action.
 */
export async function pushApplicationStatus(
  store: Store,
  ctx: Pick<TenantContext, "tenantId" | "requestId">,
  crm: ZohoCrmClient | null,
  app: Record<string, unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (!crm || !app.zoho_lead_id) return false;
  try {
    await withRetry(
      () => crm.updateLead(String(app.zoho_lead_id), {
        [CRM_LEAD_FIELDS.applicationCode]: app.application_code,
        [CRM_LEAD_FIELDS.applicationStatus]: app.status,
      }),
      { store, tenantId: ctx.tenantId, sourceSystem: "CRM", entityType: "application", entityId: String(app.ROWID), operation: "lead.status", requestId: ctx.requestId },
      { sleep: opts.sleep },
    );
    return true;
  } catch (e) {
    log("warn", "crm.status_push_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error).message) });
    return false;
  }
}
