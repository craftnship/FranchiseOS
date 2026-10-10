import { CatalystStore } from "../common/catalystStore";
import { log } from "../common/logger";
import { mailerFromEnv } from "../common/mailer";
import { newRequestId } from "../common/response";
import { zohoCredentialsFromEnv, zohoFactory } from "../integrations/tenantClients";
import { runProjectRiskJob } from "../workflows/readiness";
import { runReminderJob } from "../workflows/notifications";
import { runReservationJob } from "../workflows/territoryReservation";
import { runTwoWaySyncJob } from "../workflows/twoWaySync";

// Entry point of the fos_jobs Cron function (spec §22). The Catalyst cron calls it daily; it runs
// job_project_risk (sync Zoho task progress, then refresh readiness and risk for active projects),
// then job_two_way_sync (Books fee payments and CRM contact edits back into FOS), then
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
    const zoho = zohoFactory(store, zohoCredentialsFromEnv());
    await runProjectRiskJob(store, async (tenantId) => (await zoho(tenantId))?.projects ?? null, { today: now.toISOString().slice(0, 10), now, requestId, mailer });
    await runTwoWaySyncJob(store, zoho, { now, requestId, mailer });
    await runReservationJob(store, { now, requestId, mailer });
    await runReminderJob(store, { now, requestId, mailer });
    context.closeWithSuccess();
  } catch (e) {
    log("error", "job.crash", { request_id: requestId, error: String((e as Error)?.stack ?? e) });
    context.closeWithFailure();
  }
}
