import { Store } from "../common/store";
import { HttpBooksClient } from "./booksClient";
import { ZohoBooksClient, ZohoCrmClient, ZohoProjectsClient, ZohoSignClient } from "./clients";
import { HttpCrmClient } from "./crmClient";
import { CrmFactory } from "./crmSync";
import { HttpProjectsClient } from "./projectsClient";
import { HttpSignClient } from "./signClient";
import { endpointsFor, FetchLike, RefreshTokenProvider, ZohoHttp } from "./zohoHttp";

// Per-tenant Zoho connection (plan Step 2.1). The tenant_integrations row (provider ZOHO) holds the
// data center, the Books organization (org_id), the Projects portal (portal_id) and the encrypted
// refresh token; the OAuth client comes from function env variables.

export interface ZohoAppCredentials { clientId: string; clientSecret: string }

export function zohoCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): ZohoAppCredentials | null {
  return env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET ? { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET } : null;
}

/** Clients for one tenant. Books and Projects are null until their org or portal is configured. */
export interface ZohoClients {
  crm: ZohoCrmClient;
  sign: ZohoSignClient;
  books: ZohoBooksClient | null;
  projects: ZohoProjectsClient | null;
}

export type ZohoFactory = (tenantId: string) => Promise<ZohoClients | null>;

/**
 * For the single pilot tenant the refresh token may live in the function's ZOHO_REFRESH_TOKEN env
 * variable instead of the tenant_integrations row.
 */
export function zohoFactory(store: Store, app: ZohoAppCredentials | null, fetchFn?: FetchLike, env: NodeJS.ProcessEnv = process.env): ZohoFactory {
  return async (tenantId) => {
    if (!app) return null;
    const row = await store.findOne("tenant_integrations", { tenant_id: tenantId, provider: "ZOHO", status: "ACTIVE" });
    const refreshToken = row?.refresh_token || env.ZOHO_REFRESH_TOKEN;
    if (!row || !refreshToken) return null;
    const endpoints = endpointsFor(String(row.zoho_dc));
    const http = new ZohoHttp(new RefreshTokenProvider(endpoints, { ...app, refreshToken: String(refreshToken) }, fetchFn), fetchFn);
    const tenant = await store.findOne("tenants", { ROWID: tenantId });
    let settings: Record<string, unknown> = {};
    try { settings = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { settings = {}; }
    return {
      crm: new HttpCrmClient(http, endpoints.crm),
      sign: new HttpSignClient(http, endpoints.sign),
      books: row.org_id ? new HttpBooksClient(http, endpoints.books, String(row.org_id)) : null,
      projects: row.portal_id ? new HttpProjectsClient(http, endpoints.projects, String(row.portal_id), settings.projects_owner_zpuid ? String(settings.projects_owner_zpuid) : undefined) : null,
    };
  };
}

export function crmFactory(store: Store, app: ZohoAppCredentials | null, fetchFn?: FetchLike, env: NodeJS.ProcessEnv = process.env): CrmFactory {
  const zoho = zohoFactory(store, app, fetchFn, env);
  return async (tenantId) => (await zoho(tenantId))?.crm ?? null;
}
