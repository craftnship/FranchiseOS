import { createHash, timingSafeEqual } from "crypto";
import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { log } from "../common/logger";
import { fail, newRequestId, ok } from "../common/response";
import { Store } from "../common/store";
import { CrmFactory } from "../integrations/crmSync";
import { normalizePath } from "../api/router";
import { DEFAULT_CRM_TRIGGER_STATUS, handleCrmLead } from "./crmLead";

// Webhook entry (§14). These routes have no Catalyst user, so each call must carry the tenant's
// shared secret (header x-fos-webhook-secret, or `token` in the query or form body for senders that cannot set headers).

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  body: unknown;
}

export interface WebhookDeps {
  store: Store;
  crm: CrmFactory;
  sleep?: (ms: number) => Promise<void>;
  /** Pilot fallback when the tenant_integrations row has no webhook_secret (env FOS_CRM_WEBHOOK_SECRET). */
  fallbackSecret?: string;
}

const LEAD_ROUTE = /^\/webhooks\/crm\/lead\/([A-Za-z0-9_-]{1,40})$/;

function sameSecret(given: string, expected: string): boolean {
  // Hash both so lengths match and the comparison is constant time.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function header(h: WebhookRequest["headers"], name: string): string {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<{ status: number; body: unknown }> {
  const requestId = newRequestId();
  try {
    const m = LEAD_ROUTE.exec(normalizePath(req.path));
    if (!m || req.method.toUpperCase() !== "POST") throw new AppError("NOT_FOUND", "Route not found.");

    const tenant = await deps.store.findOne("tenants", { tenant_code: m[1].toUpperCase() });
    const integration = tenant && tenant.status === "ACTIVE"
      ? await deps.store.findOne("tenant_integrations", { tenant_id: String(tenant.ROWID), provider: "ZOHO", status: "ACTIVE" })
      : null;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Zoho CRM sends a webhook's custom parameters in the form body, so `token` is accepted there too.
    const given = header(req.headers, "x-fos-webhook-secret") || req.query.token || (typeof body.token === "string" ? body.token : "");
    // Unknown tenant and wrong secret answer the same way.
    const expected = integration ? String(integration.webhook_secret || deps.fallbackSecret || "") : "";
    if (!expected || !given || !sameSecret(given, expected)) throw new AppError("WEBHOOK_SIGNATURE_INVALID");

    const leadId = String(body.lead_id ?? body.id ?? req.query.lead_id ?? "").trim();
    if (!/^\d{1,25}$/.test(leadId)) throw new AppError("VALIDATION_FAILED", "lead_id is required.", { lead_id: "required" });

    const tenantId = String(tenant!.ROWID);
    const crm = await deps.crm(tenantId);
    if (!crm) throw new AppError("ZOHO_SYNC_FAILED", "Zoho CRM is not connected for this tenant.");
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:crm", roles: ["SYSTEM"], zohoDc: String(tenant!.zoho_dc), requestId, correlationId: requestId };
    const settings = tenant!.settings_json ? JSON.parse(String(tenant!.settings_json)) : {};
    const result = await handleCrmLead(deps.store, ctx, crm, { leadId, triggerStatus: settings.crm_trigger_status ?? DEFAULT_CRM_TRIGGER_STATUS, sleep: deps.sleep });
    log("info", "webhook.crm_lead", { request_id: requestId, tenant_id: tenantId, external_id: leadId, action: result.action });
    return { status: 200, body: ok(result, requestId) };
  } catch (err) {
    if (err instanceof AppError) log("warn", "webhook.rejected", { request_id: requestId, code: err.code, error: err.message });
    else log("error", "webhook.unhandled", { request_id: requestId, error: String((err as Error)?.message ?? err) });
    return fail(err, requestId);
  }
}
