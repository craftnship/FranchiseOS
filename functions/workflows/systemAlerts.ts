import { TenantContext } from "../common/context";
import { log } from "../common/logger";
import { Store } from "../common/store";
import { deliver } from "./notifications";

// Alerts to the tenant's super admins when something needs a person: a Zoho call that gave up
// (dead letter), a webhook that failed, or a step of the daily job that crashed.

export const HEALTH_LINK = "/admin/integrations";

export async function alertAdmins(store: Store, tenantId: string, n: { kind: string; title: string; body?: string; entityType: string; entityId: string; dedupe: string }): Promise<void> {
  try {
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:health", roles: ["SYSTEM"], zohoDc: "", requestId: "health", correlationId: "health" };
    await deliver(store, ctx, { ...n, roles: ["SUPER_ADMIN"], link: HEALTH_LINK });
  } catch (e) {
    log("warn", "health.alert_failed", { tenant_id: tenantId, kind: n.kind, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}

export const JOB_STEPS = ["project_risk", "two_way_sync", "pos_sales", "store_health", "reservation_expiry", "reminders"] as const;
export const JOB_LABEL: Record<string, string> = { project_risk: "Project risk and Zoho Projects sync", two_way_sync: "Books payments and CRM edits", pos_sales: "POS sales from franchisee Books", store_health: "Franchisee health score", reservation_expiry: "Territory reservations", reminders: "Daily reminders" };

/** One row per active tenant per step of the daily job, so the health screen shows the last run; a failure alerts. */
export async function recordJobRun(store: Store, run: { step: string; ok: boolean; error?: string; requestId: string; now: Date }): Promise<void> {
  try {
    for (const t of await store.findMany("tenants", { status: "ACTIVE" })) {
      const tenantId = String(t.ROWID);
      await store.insert("integration_logs", {
        tenant_id: tenantId, source_system: "FOS_JOBS", entity_type: "job", entity_id: run.step, operation: run.step,
        status: run.ok ? "SUCCESS" : "FAILED", attempt: 1, request_id: run.requestId, error_code: run.ok ? null : "JOB_FAILED",
        error_message: run.error ? run.error.slice(0, 500) : null,
      });
      if (!run.ok) {
        await alertAdmins(store, tenantId, {
          kind: "health.job", entityType: "job", entityId: run.step, dedupe: `job:${run.step}:${run.now.toISOString().slice(0, 10)}`,
          title: `Daily job failed: ${JOB_LABEL[run.step] ?? run.step}`,
          body: `${(run.error ?? "Unknown error").split("\n")[0].slice(0, 200)} The other steps still ran. It runs again tomorrow; check Integration health.`,
        });
      }
    }
  } catch (e) {
    log("error", "job.record_failed", { request_id: run.requestId, step: run.step, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}
