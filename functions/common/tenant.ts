import { AppError } from "./errors";
import { TenantContext } from "./context";

export interface IdentityUser {
  /** Catalyst Authentication user id (getCurrentUser().user_id). */
  externalUserId: string;
  email: string;
}

export interface UserDirectory {
  findActiveByExternalId(externalUserId: string): Promise<{ userId: string; tenantId: string; roleCodes: string[]; franchiseeId?: string } | null>;
  findTenant(tenantId: string): Promise<{ tenantId: string; status: string; zohoDc: string } | null>;
}

/**
 * Resolves tenant and roles from the authenticated user only.
 * Any tenant_id the client sends is ignored by design (§6, FOS-005).
 */
export async function resolveTenant(
  identity: IdentityUser | null,
  dir: UserDirectory,
  ids: { requestId: string; correlationId?: string },
): Promise<TenantContext> {
  if (!identity) throw new AppError("AUTH_REQUIRED");
  const user = await dir.findActiveByExternalId(identity.externalUserId);
  if (!user) throw new AppError("ACCESS_DENIED", "User is not provisioned for any tenant.");
  const tenant = await dir.findTenant(user.tenantId);
  if (!tenant || tenant.status !== "ACTIVE") throw new AppError("TENANT_NOT_FOUND");
  return {
    tenantId: tenant.tenantId,
    userId: user.userId,
    roles: user.roleCodes,
    zohoDc: tenant.zohoDc,
    requestId: ids.requestId,
    correlationId: ids.correlationId ?? ids.requestId,
    ...(user.franchiseeId ? { franchiseeId: user.franchiseeId } : {}),
  };
}
