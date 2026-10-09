import { createHash, timingSafeEqual } from "crypto";
import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { log } from "../common/logger";
import { fail, newRequestId, ok } from "../common/response";
import { Store } from "../common/store";
import { CrmFactory, pushApplicationStatus } from "../integrations/crmSync";
import { normalizePath } from "../api/router";
import { ProviderError } from "../integrations/retry";
import { DEFAULT_CRM_TRIGGER_STATUS, handleCrmLead } from "./crmLead";
import { ZohoFactory } from "../integrations/tenantClients";
import { handleSignEvent, sendAgreement, SYSTEM_PERMISSIONS } from "../workflows/agreements";

// Webhook entry (§14): POST /webhooks/crm/lead/:TENANT and /webhooks/sign/:TENANT. These routes have no Catalyst user, so each call must carry the tenant's
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
  /** All Zoho clients for the Sign callback (Sign, CRM, Books, Projects). */
  zoho?: ZohoFactory;
  sleep?: (ms: number) => Promise<void>;
  /** Pilot fallback when the tenant_integrations row has no webhook_secret (env FOS_CRM_WEBHOOK_SECRET). */
  fallbackSecret?: string;
}

const LEAD_ROUTE = /^\/webhooks\/crm\/lead\/([A-Za-z0-9_-]{1,40})$/;
const SIGN_ROUTE = /^\/webhooks\/sign\/([A-Za-z0-9_-]{1,40})$/;
// Development only: sends an agreement before staff logins exist. Off unless the tenant setting
// test_routes_enabled is true, and protected by the same secret as the webhooks.
const TEST_AGREEMENT_ROUTE = /^\/webhooks\/test\/agreement\/([A-Za-z0-9_-]{1,40})$/;

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
    const path = normalizePath(req.path);
    const m = LEAD_ROUTE.exec(path) ?? SIGN_ROUTE.exec(path) ?? TEST_AGREEMENT_ROUTE.exec(path);
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

    const tenantId = String(tenant!.ROWID);
    const ctx: TenantContext = { tenantId, userId: SIGN_ROUTE.test(path) ? "SYSTEM:sign" : TEST_AGREEMENT_ROUTE.test(path) ? "SYSTEM:test" : "SYSTEM:crm", roles: ["SYSTEM"], zohoDc: String(tenant!.zoho_dc), requestId, correlationId: requestId };
    if (SIGN_ROUTE.test(path)) return { status: 200, body: ok(await signCallback(body, ctx, deps), requestId) };
    if (TEST_AGREEMENT_ROUTE.test(path)) return { status: 200, body: ok(await testSendAgreement(tenant!, body, ctx, deps), requestId) };

    // Zoho CRM may send webhook parameters as headers; proxies drop header names with "_", so "lead-id" is accepted too.
    const leadId = [body.lead_id, body.id, req.query.lead_id, req.query.id, header(req.headers, "lead-id"), header(req.headers, "lead_id")]
      .map((v) => String(v ?? "").trim()).find(Boolean) ?? "";
    if (!/^\d{1,25}$/.test(leadId)) {
      // Names only, never values: shows what the sender actually posted when lead_id is missing.
      log("warn", "webhook.lead_id_missing", { request_id: requestId, content_type: header(req.headers, "content-type"), body_keys: Object.keys(body).join(","), query_keys: Object.keys(req.query).join(","), header_keys: Object.keys(req.headers).join(",") });
      throw new AppError("VALIDATION_FAILED", "lead_id is required.", { lead_id: "required" });
    }

    const crm = await deps.crm(tenantId);
    if (!crm) throw new AppError("ZOHO_SYNC_FAILED", "Zoho CRM is not connected for this tenant.");
    const settings = tenant!.settings_json ? JSON.parse(String(tenant!.settings_json)) : {};
    const result = await handleCrmLead(deps.store, ctx, crm, { leadId, triggerStatus: settings.crm_trigger_status ?? DEFAULT_CRM_TRIGGER_STATUS, sleep: deps.sleep });
    log("info", "webhook.crm_lead", { request_id: requestId, tenant_id: tenantId, external_id: leadId, action: result.action });
    return { status: 200, body: ok(result, requestId) };
  } catch (caught) {
    // Zoho's own reason (e.g. invalid_client, INVALID_TOKEN) carries no secrets and says what to fix.
    const err = caught instanceof ProviderError ? new AppError("ZOHO_SYNC_FAILED", caught.message.slice(0, 300)) : caught;
    if (err instanceof AppError) log("warn", "webhook.rejected", { request_id: requestId, code: err.code, error: err.message });
    else log("error", "webhook.unhandled", { request_id: requestId, error: String((err as Error)?.message ?? err) });
    return fail(err, requestId);
  }
}

/**
 * Zoho Sign callback (FOS-047). The payload is { requests: { request_id, ... }, notifications:
 * { operation_type } }; only the request id is used and its status is read back from Sign.
 */
async function signCallback(body: Record<string, unknown>, ctx: TenantContext, deps: WebhookDeps) {
  const requests = (body.requests ?? {}) as Record<string, unknown>;
  const notifications = (body.notifications ?? {}) as Record<string, unknown>;
  const signRequestId = String(requests.request_id ?? body.request_id ?? "").trim();
  if (!/^\d{1,25}$/.test(signRequestId)) {
    log("warn", "webhook.sign_request_missing", { request_id: ctx.requestId, body_keys: Object.keys(body).join(",") });
    throw new AppError("VALIDATION_FAILED", "request_id is required.", { request_id: "required" });
  }
  const zoho = deps.zoho ? await deps.zoho(ctx.tenantId) : null;
  if (!zoho) throw new AppError("ZOHO_SYNC_FAILED", "Zoho is not connected for this tenant.");
  const operation = typeof notifications.operation_type === "string" ? notifications.operation_type : undefined;
  const result = await handleSignEvent(deps.store, ctx, zoho, { requestId: signRequestId, operation, onTransition: async (e) => {
    if (e.entityType === "application") await pushApplicationStatus(deps.store, ctx, zoho.crm, e.entity, { sleep: deps.sleep });
  } });
  log("info", "webhook.sign", { request_id: ctx.requestId, tenant_id: ctx.tenantId, external_id: signRequestId, action: result.action });
  return result;
}

async function testSendAgreement(tenant: Record<string, unknown>, body: Record<string, unknown>, ctx: TenantContext, deps: WebhookDeps) {
  let settings: Record<string, unknown> = {};
  try { settings = tenant.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { settings = {}; }
  if (settings.test_routes_enabled !== true) throw new AppError("NOT_FOUND", "Route not found.");
  const applicationId = String(body.application_id ?? "").trim();
  if (!/^\d{1,25}$/.test(applicationId)) throw new AppError("VALIDATION_FAILED", "application_id is required.", { application_id: "required" });
  const zoho = deps.zoho ? await deps.zoho(ctx.tenantId) : null;
  if (!zoho) throw new AppError("ZOHO_SYNC_FAILED", "Zoho is not connected for this tenant.");
  return sendAgreement(deps.store, ctx, zoho.sign, { applicationId, permissions: SYSTEM_PERMISSIONS, onTransition: async (e) => {
    if (e.entityType === "application") await pushApplicationStatus(deps.store, ctx, zoho.crm, e.entity, { sleep: deps.sleep });
  } });
}
