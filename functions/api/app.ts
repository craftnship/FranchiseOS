import { Router } from "./router";
import { agreementRoutes } from "./routes/agreements";
import { applicationRoutes } from "./routes/applications";
import { approvalRoutes } from "./routes/approvals";
import { feasibilityRoutes } from "./routes/feasibility";
import { franchiseeRoutes } from "./routes/franchisees";
import { projectRoutes } from "./routes/projects";
import { siteRoutes } from "./routes/sites";
import { territoryRoutes } from "./routes/territories";

/** The /api/v1 surface served by the fos_api Advanced I/O function. */
export function buildRouter(): Router {
  const r = new Router();
  r.on("GET", "/me", null, async (call) => ({ user_id: call.ctx.userId, tenant_id: call.ctx.tenantId, roles: call.ctx.roles, franchisee_id: call.ctx.franchiseeId ?? null }));
  franchiseeRoutes(r);
  applicationRoutes(r);
  territoryRoutes(r);
  siteRoutes(r);
  feasibilityRoutes(r);
  approvalRoutes(r);
  agreementRoutes(r);
  projectRoutes(r);
  return r;
}
