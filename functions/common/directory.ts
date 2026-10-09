import { PermissionLookup } from "./rbac";
import { Store } from "./store";
import { UserDirectory } from "./tenant";

/** UserDirectory over the users, roles and tenants tables. */
export class StoreUserDirectory implements UserDirectory {
  constructor(private readonly store: Store) {}

  async findActiveByExternalId(externalUserId: string) {
    const user = await this.store.findOne("users", { external_user_id: externalUserId, status: "ACTIVE" });
    if (!user) return null;
    const tenantId = String(user.tenant_id);
    const role = user.role_id ? await this.store.findOne("roles", { ROWID: String(user.role_id), tenant_id: tenantId }) : null;
    return {
      userId: String(user.ROWID),
      tenantId,
      roleCodes: role ? [String(role.code)] : [],
      ...(user.franchisee_id ? { franchiseeId: String(user.franchisee_id) } : {}),
    };
  }

  async findTenant(tenantId: string) {
    const t = await this.store.findOne("tenants", { ROWID: tenantId });
    return t ? { tenantId: String(t.ROWID), status: String(t.status), zohoDc: String(t.zoho_dc) } : null;
  }
}

/** Permissions from role_permissions for the caller's tenant, memoised for one request. */
export function storePermissionLookup(store: Store, tenantId: string): PermissionLookup {
  const cache = new Map<string, Set<string>>();
  return async (roles) => {
    const key = [...roles].sort().join(",");
    const hit = cache.get(key);
    if (hit) return hit;
    const perms = new Set<string>();
    for (const code of roles) {
      const role = await store.findOne("roles", { tenant_code_key: `${tenantId}:ROLE:${code}` });
      if (!role) continue;
      const rows = await store.findMany("role_permissions", { tenant_id: tenantId, role_id: String(role.ROWID) });
      for (const r of rows) perms.add(String(r.permission_code));
    }
    cache.set(key, perms);
    return perms;
  };
}
