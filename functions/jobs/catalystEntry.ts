import { CatalystStore } from "../common/catalystStore";
import { log } from "../common/logger";
import { newRequestId } from "../common/response";
import { zohoCredentialsFromEnv, zohoFactory } from "../integrations/tenantClients";
import { runProjectRiskJob } from "../workflows/readiness";
import { runTwoWaySyncJob } from "../workflows/twoWaySync";

// Entry point of the fos_jobs Cron function (spec §22). The Catalyst cron calls it daily; it runs
// job_project_risk (sync Zoho task progress, then refresh readiness and risk for active projects),
// then job_two_way_sync (Books fee payments and CRM contact edits back into FOS).

interface CronContext { closeWithSuccess(): void; closeWithFailure(): void }
interface CatalystSdk { initialize(ctx: unknown): ConstructorParameters<typeof CatalystStore>[0] }

export async function runCron(context: CronContext, sdk: CatalystSdk, now = new Date()): Promise<void> {
  const requestId = newRequestId();
  try {
    const store = new CatalystStore(sdk.initialize(context));
    const zoho = zohoFactory(store, zohoCredentialsFromEnv());
    await runProjectRiskJob(store, async (tenantId) => (await zoho(tenantId))?.projects ?? null, { today: now.toISOString().slice(0, 10), now, requestId });
    await runTwoWaySyncJob(store, zoho, { now, requestId });
    context.closeWithSuccess();
  } catch (e) {
    log("error", "job.crash", { request_id: requestId, error: String((e as Error)?.stack ?? e) });
    context.closeWithFailure();
  }
}
