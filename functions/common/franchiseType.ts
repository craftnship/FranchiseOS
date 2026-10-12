import { Row, Store } from "./store";

// The format new franchisees get when none is given (a CRM lead without one, an agreement or
// project for a franchisee without one). Tenants set settings_json.default_franchise_type.

export const FALLBACK_FRANCHISE_TYPE = "QSR";

export function defaultFranchiseType(tenant: Row | null | undefined): string {
  try {
    const s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {};
    return typeof s.default_franchise_type === "string" && s.default_franchise_type.trim() ? s.default_franchise_type.trim() : FALLBACK_FRANCHISE_TYPE;
  } catch { return FALLBACK_FRANCHISE_TYPE; }
}

export async function franchiseTypeOf(store: Store, tenantId: string, franchisee: Row | null | undefined): Promise<string> {
  const own = franchisee?.franchise_type ? String(franchisee.franchise_type).trim() : "";
  return own || defaultFranchiseType(await store.findOne("tenants", { ROWID: tenantId }));
}
