import { AppError } from "./errors";
import { TenantContext } from "./context";

// Roles from spec §7.
export const ROLES = [
  "SUPER_ADMIN",
  "FRANCHISE_DIRECTOR",
  "FRANCHISE_MANAGER",
  "FINANCE_MANAGER",
  "LEGAL_MANAGER",
  "PROJECT_MANAGER",
  "TRAINING_MANAGER",
  "OPERATIONS_MANAGER",
  "REGIONAL_MANAGER",
  "FRANCHISEE",
  "FRANCHISEE_STAFF",
  "VENDOR",
] as const;
export type Role = (typeof ROLES)[number];

export type PermissionLookup = (roles: string[]) => Promise<Set<string>>;

/** Server-side RBAC (§6, §30). Permissions come from role_permissions, never from the client. */
export async function authorize(ctx: TenantContext, permission: string, lookup: PermissionLookup): Promise<void> {
  if (ctx.roles.includes("SUPER_ADMIN")) return;
  const perms = await lookup(ctx.roles);
  if (!perms.has(permission)) throw new AppError("ACCESS_DENIED", `Missing permission ${permission}.`);
}

/** Franchisee-facing roles may only touch their own records (§25, FOS-048). */
export function isPortalUser(ctx: TenantContext): boolean {
  return ctx.roles.every((r) => r === "FRANCHISEE" || r === "FRANCHISEE_STAFF" || r === "VENDOR");
}
