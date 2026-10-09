import type { IncomingMessage, ServerResponse } from "http";
import { readBody, send } from "../api/catalystEntry";
import { CatalystStore } from "../common/catalystStore";
import { crmFactory, zohoCredentialsFromEnv, zohoFactory } from "../integrations/tenantClients";
import { handleWebhook } from "./router";

// Entry point of the fos_webhooks Advanced I/O function. Its API Gateway route has no Catalyst
// Authentication; the tenant's shared secret is checked in handleWebhook instead.

interface CatalystSdk { initialize(req: IncomingMessage, opts?: { scope?: string }): ConstructorParameters<typeof CatalystStore>[0] }

export async function handleWebhookRequest(req: IncomingMessage, res: ServerResponse, sdk: CatalystSdk): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let body: unknown = {};
  let raw = "";
  try {
    raw = await readBody(req);
    const type = String(req.headers["content-type"] ?? "");
    body = !raw ? {} : type.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
  } catch {
    send(res, 400, { success: false, error: { code: "INVALID_REQUEST", message: "Unreadable body." } });
    return;
  }
  // Admin scope: there is no end user on a webhook call.
  const store = new CatalystStore(sdk.initialize(req, { scope: "admin" }));
  const result = await handleWebhook(
    { method: req.method ?? "POST", path: url.pathname, headers: req.headers, query: Object.fromEntries(url.searchParams), body, rawBody: raw },
    { store, crm: crmFactory(store, zohoCredentialsFromEnv()), zoho: zohoFactory(store, zohoCredentialsFromEnv()), fallbackSecret: process.env.FOS_CRM_WEBHOOK_SECRET, signSecret: process.env.FOS_SIGN_WEBHOOK_SECRET || undefined },
  );
  send(res, result.status, result.body);
}
