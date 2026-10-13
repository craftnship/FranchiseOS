import { CatalystStore, describeError } from "../common/catalystStore";
import { log } from "../common/logger";
import { mailerFromEnv } from "../common/mailer";
import { newRequestId } from "../common/response";
import { franchiseeBooks, zohoCredentialsFromEnv, zohoFactory } from "../integrations/tenantClients";
import { runProjectRiskJob } from "../workflows/readiness";
import { runReminderJob } from "../workflows/notifications";
import { runReservationJob } from "../workflows/territoryReservation";
import { runPosSalesJob } from "../workflows/posSales";
import { runStoreHealthJob } from "../workflows/storeHealth";
import { runTwoWaySyncJob } from "../workflows/twoWaySync";
import { recordJobRun } from "../workflows/systemAlerts";

// Entry point of the fos_jobs Cron function (spec §22). The Catalyst cron calls it daily; it runs
// job_project_risk (sync Zoho task progress, then refresh readiness and risk for active projects),
// then job_two_way_sync (Books fee payments and CRM contact edits back into FOS), then job_pos_sales (each
// store's daily sales from the franchisee's Books, and months closed from them), then job_store_health
// (the franchisee health score for every trading store), then
// job_reservation_expiry (territory reservations lapse, free or become allocations), then
// job_reminders (overdue approvals, tasks and openings, unsigned agreements, expiring holds).

interface CronContext { closeWithSuccess(): void; closeWithFailure(): void }
interface CatalystSdk { initialize(ctx: unknown): ConstructorParameters<typeof CatalystStore>[0] }

export async function runCron(context: CronContext, sdk: CatalystSdk, now = new Date()): Promise<void> {
  const requestId = newRequestId();
  try {
    const app = sdk.initialize(context);
    const store = new CatalystStore(app);
    const mailer = mailerFromEnv(app);
    const creds = zohoCredentialsFromEnv();
    const zoho = zohoFactory(store, creds);
    const steps: [string, () => Promise<unknown>][] = [
      ["project_risk", () => runProjectRiskJob(store, async (tenantId) => (await zoho(tenantId))?.projects ?? null, { today: now.toISOString().slice(0, 10), now, requestId, mailer })],
      ["two_way_sync", () => runTwoWaySyncJob(store, zoho, { now, requestId, mailer })],
      ["pos_sales", () => runPosSalesJob(store, (conn) => (creds ? franchiseeBooks(creds, conn) : null), zoho, { today: now.toISOString().slice(0, 10), now, requestId, mailer })],
      ["store_health", () => runStoreHealthJob(store, { today: now.toISOString().slice(0, 10), now, requestId, mailer })],
      ["reservation_expiry", () => runReservationJob(store, { now, requestId, mailer })],
      ["reminders", () => runReminderJob(store, { now, requestId, mailer })],
    ];
    // A failing step is recorded and alerted, and the later steps still run.
    let failed = 0;
    for (const [step, run] of steps) {
      try {
        const result = await run() as { failed?: number } | undefined;
        // A step that got through but lost some tenants or records is a failure to the people on call.
        const lost = Number(result?.failed ?? 0);
        if (lost > 0) { failed++; await recordJobRun(store, { step, ok: false, error: `${lost} item${lost === 1 ? "" : "s"} failed inside the step; see the logs for job.${step}`, requestId, now }); }
        else await recordJobRun(store, { step, ok: true, requestId, now });
      } catch (e) {
        failed++;
        const error = describeError(e);
        log("error", "job.crash", { request_id: requestId, step, error });
        await recordJobRun(store, { step, ok: false, error, requestId, now });
      }
    }
    if (failed) context.closeWithFailure(); else context.closeWithSuccess();
  } catch (e) {
    log("error", "job.crash", { request_id: requestId, error: describeError(e) });
    context.closeWithFailure();
  }
}
