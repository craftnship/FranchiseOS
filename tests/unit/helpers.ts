import { MemoryStore } from "../../functions/common/memoryStore";
import { TenantContext } from "../../functions/common/context";
import { TABLES } from "../../database/schema/tables";
import { ROLE_PERMISSIONS } from "../../database/seed/defaults";

export function newStore(): MemoryStore {
  const unique: Record<string, string[]> = {};
  for (const t of TABLES) unique[t.name] = t.columns.filter((c) => c.unique).map((c) => c.name);
  return new MemoryStore(unique);
}

export function ctx(roles: string[], tenantId = "T1", userId = "U1"): TenantContext {
  return { tenantId, userId, roles, zohoDc: "IN", requestId: "REQ-test", correlationId: "COR-test" };
}

export const permissions = async (roles: string[]) =>
  new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []).concat(roles.includes("SYSTEM") ? ["system.approval", "system.sign", "system.project"] : []));
