import { Store } from "../common/store";
import { HttpCrmClient } from "./crmClient";
import { CrmFactory } from "./crmSync";
import { endpointsFor, FetchLike, RefreshTokenProvider, ZohoHttp } from "./zohoHttp";

// Per-tenant Zoho connection (plan Step 2.1). The tenant_integrations row (provider ZOHO) holds the
// data center and the encrypted refresh token; the OAuth client comes from function env variables.

export interface ZohoAppCredentials { clientId: string; clientSecret: string }

export function zohoCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): ZohoAppCredentials | null {
  return env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET ? { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET } : null;
}

/**
 * For the single pilot tenant the refresh token may live in the function's ZOHO_REFRESH_TOKEN env
 * variable instead of the tenant_integrations row.
 */
export function crmFactory(store: Store, app: ZohoAppCredentials | null, fetchFn?: FetchLike, env: NodeJS.ProcessEnv = process.env): CrmFactory {
  return async (tenantId) => {
    if (!app) return null;
    const row = await store.findOne("tenant_integrations", { tenant_id: tenantId, provider: "ZOHO", status: "ACTIVE" });
    const refreshToken = row?.refresh_token || env.ZOHO_REFRESH_TOKEN;
    if (!row || !refreshToken) return null;
    const endpoints = endpointsFor(String(row.zoho_dc));
    const http = new ZohoHttp(new RefreshTokenProvider(endpoints, { ...app, refreshToken: String(refreshToken) }, fetchFn), fetchFn);
    return new HttpCrmClient(http, endpoints.crm);
  };
}
