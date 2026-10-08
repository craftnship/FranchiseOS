import { TenantContext } from "./context";
import { Store } from "./store";

/** Activity log (§6 "audit events"; named activity log per D-18 to avoid clashing with field audits). */
export async function logActivity(
  store: Store,
  ctx: Pick<TenantContext, "tenantId" | "userId" | "correlationId">,
  entry: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await store.insert("activity_logs", {
    tenant_id: ctx.tenantId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    actor_user_id: ctx.userId,
    metadata_json: JSON.stringify({ ...entry.metadata, correlation_id: ctx.correlationId }),
    created_at: new Date().toISOString(),
  });
}
