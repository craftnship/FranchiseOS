import { Call, Router } from "./router";
import { agreementRoutes } from "./routes/agreements";
import { dashboardRoutes } from "./routes/dashboards";
import { ownerRoutes } from "./routes/owner";
import { networkMapRoutes } from "./routes/networkMap";
import { regionRoutes } from "./routes/regions";
import { healthRoutes } from "./routes/health";
import { applicationRoutes } from "./routes/applications";
import { approvalRoutes } from "./routes/approvals";
import { feasibilityRoutes } from "./routes/feasibility";
import { franchiseeRoutes } from "./routes/franchisees";
import { notificationRoutes } from "./routes/notifications";
import { auditRoutes } from "./routes/audit";
import { userRoutes } from "./routes/users";
import { integrationRoutes } from "./routes/integrations";
import { royaltyRoutes } from "./routes/royalties";
import { analyticsRoutes } from "./routes/analytics";
import { constructionRoutes } from "./routes/construction";
import { staffingRoutes } from "./routes/staffing";
import { purchasingRoutes } from "./routes/purchasing";
import { fundingRoutes } from "./routes/funding";
import { auditRoutes as storeAuditRoutes } from "./routes/audits";
import { launchRoutes } from "./routes/launch";
import { portalHubRoutes, portalRoutes } from "./routes/portal";
import { posRoutes } from "./routes/pos";
import { collectionRoutes } from "./routes/collections";
import { projectRoutes } from "./routes/projects";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { siteRoutes } from "./routes/sites";
import { territoryRoutes } from "./routes/territories";
import { isPortalUser } from "../common/rbac";
import { ZohoWeb, zohoWebFor } from "../integrations/region";

async function zohoWeb(call: Call): Promise<ZohoWeb | null> {
  const row = await call.store.findOne("tenant_integrations", { tenant_id: call.ctx.tenantId, provider: "ZOHO", status: "ACTIVE" });
  try { return row?.zoho_dc ? zohoWebFor(String(row.zoho_dc), row.org_id ? String(row.org_id) : null) : null; } catch { return null; }
}

/** The /api/v1 surface served by the fos_api Advanced I/O function. */
export function buildRouter(): Router {
  const r = new Router();
  r.on("GET", "/me", null, async (call) => ({
    user_id: call.ctx.userId, tenant_id: call.ctx.tenantId, roles: call.ctx.roles, franchisee_id: call.ctx.franchiseeId ?? null, region: call.ctx.region ?? null,
    // Who is signed in, for the header.
    ...await call.repo.findOne("users", { ROWID: call.ctx.userId }).then((u) => ({ name: (u?.name as string) ?? null, email: (u?.email as string) ?? null })),
    // For showing only the actions the caller may take; every route still checks on the server.
    permissions: call.ctx.roles.includes("SUPER_ADMIN") ? ["*"] : [...await call.permissions(call.ctx.roles)].sort(),
    // Staff get the tenant's Zoho web addresses, so record IDs can open in Zoho.
    zoho_web: isPortalUser(call.ctx) ? null : await zohoWeb(call),
  }));
  franchiseeRoutes(r);
  applicationRoutes(r);
  territoryRoutes(r);
  siteRoutes(r);
  feasibilityRoutes(r);
  approvalRoutes(r);
  agreementRoutes(r);
  projectRoutes(r);
  dashboardRoutes(r);
  ownerRoutes(r);
  networkMapRoutes(r);
  regionRoutes(r);
  healthRoutes(r);
  searchRoutes(r);
  portalRoutes(r);
  portalHubRoutes(r);
  notificationRoutes(r);
  auditRoutes(r);
  userRoutes(r);
  integrationRoutes(r);
  royaltyRoutes(r);
  posRoutes(r);
  collectionRoutes(r);
  analyticsRoutes(r);
  constructionRoutes(r);
  staffingRoutes(r);
  purchasingRoutes(r);
  fundingRoutes(r);
  storeAuditRoutes(r);
  launchRoutes(r);
  settingsRoutes(r);
  return r;
}
