import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { authorize, PermissionLookup } from "../common/rbac";
import { Store, TenantRepo } from "../common/store";
import { logActivity } from "../common/audit";
import { ENTITY_TABLE, EntityType, findRule } from "./stateMachines";

export type BusinessRule = (entity: Record<string, unknown>, transition: string) => Promise<void>;

export interface TransitionDeps {
  store: Store;
  permissions: PermissionLookup;
  /** Optional per-entity business rules (e.g. mandatory documents before submit). */
  businessRules?: Partial<Record<EntityType, BusinessRule>>;
}

/**
 * Generic transition engine (spec §10, §40). The only code path allowed to change an entity's status.
 */
export async function transitionEntity(
  entityType: EntityType,
  entityId: string,
  transition: string,
  ctx: TenantContext,
  deps: TransitionDeps,
): Promise<Record<string, unknown>> {
  const repo = new TenantRepo(deps.store, ctx.tenantId);
  const table = ENTITY_TABLE[entityType];
  const entity = await repo.findOne(table, { ROWID: entityId });
  if (!entity) throw new AppError(entityType === "application" ? "APPLICATION_NOT_FOUND" : entityType === "site" ? "SITE_NOT_FOUND" : entityType === "agreement" ? "AGREEMENT_NOT_FOUND" : "INVALID_REQUEST");

  const from = String(entity.status);
  const rule = findRule(entityType, from, transition);
  if (!rule) {
    throw new AppError(entityType === "application" ? "APPLICATION_INVALID_STATE" : "INVALID_TRANSITION",
      `Cannot ${transition} a ${entityType} in state ${from}.`);
  }

  await authorize(ctx, rule.permission, deps.permissions);

  const missing = (rule.requiredFields ?? []).filter((f) => entity[f] === undefined || entity[f] === null || entity[f] === "");
  if (missing.length) {
    throw new AppError("VALIDATION_FAILED", "Required data is missing.", Object.fromEntries(missing.map((f) => [f, "required"])));
  }

  await deps.businessRules?.[entityType]?.(entity, transition);

  const to = typeof rule.to === "function" ? rule.to(entity) : rule.to;
  const updated = await repo.update(table, entityId, { status: to, ...(rule.sideFields?.(entity) ?? {}) });

  await logActivity(deps.store, ctx, { entityType, entityId, action: `transition:${transition}`, metadata: { from, to } });
  return updated;
}
