import { Mailer, TenantContext } from "../common/context";
import { log } from "../common/logger";
import { Store } from "../common/store";
import { ZohoClients } from "../integrations/tenantClients";
import { syncTenantContacts } from "./crmContacts";
import { syncTenantFees } from "./fees";

/**
 * job_two_way_sync (daily, after job_project_risk): Books fee payments and CRM contact edits come
 * back into FOS for every active tenant. A tenant without Zoho, or a failing one, is skipped.
 */
export async function runTwoWaySyncJob(
  store: Store,
  zohoFor: (tenantId: string) => Promise<ZohoClients | null>,
  opts: { now: Date; requestId: string; mailer?: Mailer },
) {
  const out = { tenants: 0, fees_checked: 0, fees_paid: 0, contacts_updated: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId, mailer: opts.mailer };
    const zoho = await zohoFor(tenantId).catch(() => null);
    if (!zoho) continue;
    out.tenants++;
    try {
      if (zoho.books) {
        const f = await syncTenantFees(store, ctx, zoho.books, zoho.crm, opts.now);
        out.fees_checked += f.checked; out.fees_paid += f.paid; out.failed += f.failed;
      }
      const c = await syncTenantContacts(store, ctx, zoho.crm);
      out.contacts_updated += c.updated; out.failed += c.failed;
    } catch (e) {
      out.failed++;
      log("warn", "job.two_way_sync_failed", { tenant_id: tenantId, request_id: opts.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  log("info", "job.two_way_sync", { request_id: opts.requestId, ...out });
  return out;
}
