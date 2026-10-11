import { PermissionLookup } from "./rbac";
import { Row, Store } from "./store";
import { UserDirectory } from "./tenant";

/** external_user_id of a user invited by email who has not signed in yet. */
export const pendingKey = (email: string) => `invite:${email.trim().toLowerCase()}`;

/** UserDirectory over the users, roles and tenants tables. */
export class StoreUserDirectory implements UserDirectory {
  constructor(private readonly store: Store) {}

  /**
   * An invited user becomes active on first sign-in: matched by the Catalyst user id when the
   * invite created one, else by the verified sign-in email. Deactivated users never match.
   */
  private async activate(externalUserId: string, email?: string): Promise<Row | null> {
    let user = await this.store.findOne("users", { external_user_id: externalUserId, status: "INVITED" });
    if (!user && email) user = await this.store.findOne("users", { external_user_id: pendingKey(email), status: "INVITED" });
    if (!user) return null;
    const linked = await this.store.update("users", String(user.ROWID), { external_user_id: externalUserId, status: "ACTIVE" });
    await this.store.insert("activity_logs", {
      tenant_id: user.tenant_id, entity_type: "user", entity_id: String(user.ROWID), action: "user:linked", actor_user_id: String(user.ROWID),
      metadata_json: JSON.stringify({ email: user.email }), created_at: new Date().toISOString(),
    });
    return { ...user, ...linked };
  }

  async findActiveByExternalId(externalUserId: string, email?: string) {
    const user = (await this.store.findOne("users", { external_user_id: externalUserId, status: "ACTIVE" })) ?? (await this.activate(externalUserId, email));
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
