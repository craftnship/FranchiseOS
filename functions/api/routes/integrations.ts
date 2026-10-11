import { z } from "zod";
import { logActivity } from "../../common/audit";
import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { pushApplicationStatus } from "../../integrations/crmSync";
import { DEFAULT_CRM_TRIGGER_STATUS, handleCrmLead } from "../../webhooks/crmLead";
import { handleSignEvent } from "../../workflows/agreements";
import { JOB_LABEL, JOB_STEPS } from "../../workflows/systemAlerts";
import { Call, parse, Router } from "../router";

// Integration health: Zoho connection, daily job runs, and the calls and events that need a
// person (dead letters and failed webhooks), with retry and resolve. Super admins by default.

const DAY = 86_400_000;
const target = z.object({ kind: z.enum(["log", "event"]), id: z.string().regex(/^\d{1,25}$/) });
const resolveSchema = target.extend({ reason: z.string().trim().min(3).max(500) });

const at = (r: Row) => String(r.CREATEDTIME ?? "");
const recent = (r: Row, since: string) => at(r).replace(" ", "T") >= since;

/** What a failed item is about, in the app's terms. */
async function subject(call: Call, r: Row, kind: "log" | "event"): Promise<Row | null> {
  if (kind === "log" && r.entity_type === "application" && r.entity_id) {
    const app = await call.repo.findOne("franchise_applications", { ROWID: String(r.entity_id) });
    return app ? { label: app.application_code, href: `/applications/${app.ROWID}` } : null;
  }
  if (kind === "event" && r.source_system === "CRM") {
    const app = await call.repo.findOne("franchise_applications", { zoho_lead_id: String(r.record_id) });
    return app ? { label: app.application_code, href: `/applications/${app.ROWID}` } : { label: `CRM lead ${r.record_id}`, href: null };
  }
  if (kind === "event" && r.source_system === "SIGN") {
    const ag = await call.repo.findOne("agreements", { zoho_sign_request_id: String(r.record_id) });
    return ag ? { label: ag.agreement_code, href: `/agreements/${ag.ROWID}` } : { label: `Sign request ${r.record_id}`, href: null };
  }
  return null;
}

const OPERATION: Record<string, string> = { "account.status": "Push status to CRM account", "lead.status": "Push status to CRM lead" };

async function problem(call: Call, r: Row, kind: "log" | "event"): Promise<Row> {
  return {
    kind, id: String(r.ROWID), at: at(r), source: r.source_system,
    what: kind === "log" ? OPERATION[String(r.operation)] ?? String(r.operation) : r.source_system === "CRM" ? "Lead webhook" : r.source_system === "SIGN" ? "Signature callback" : "Webhook",
    error: r.error_message ?? null, attempts: kind === "log" ? Number(r.attempt ?? 1) : null,
    subject: await subject(call, r, kind),
    retryable: kind === "event" ? ["CRM", "SIGN"].includes(String(r.source_system)) : r.source_system === "CRM" && r.entity_type === "application",
  };
}

async function load(call: Call, kind: "log" | "event", id: string): Promise<Row> {
  const r = await call.repo.findOne(kind === "log" ? "integration_logs" : "integration_events", { ROWID: id });
  if (!r) throw new AppError("NOT_FOUND", "Item not found.");
  if (kind === "log" ? r.status !== "DEAD_LETTER" : r.status !== "FAILED") throw new AppError("INVALID_TRANSITION", "This item no longer needs attention.");
  return r;
}

export function integrationRoutes(r: Router): void {
  r.on("GET", "/admin/integrations", "integration.admin", async (call) => {
    const since = new Date(call.now.getTime() - 7 * DAY).toISOString();
    const [dead, failed, logs, events, integration] = await Promise.all([
      call.repo.findMany("integration_logs", { status: "DEAD_LETTER" }, { orderBy: "ROWID", desc: true, limit: 100 }),
      call.repo.findMany("integration_events", { status: "FAILED" }, { orderBy: "ROWID", desc: true, limit: 100 }),
      call.repo.findMany("integration_logs", {}, { orderBy: "ROWID", desc: true, limit: 300 }),
      call.repo.findMany("integration_events", {}, { orderBy: "ROWID", desc: true, limit: 300 }),
      call.repo.findOne("tenant_integrations", { provider: "ZOHO" }),
    ]);
    // Last 7 days by system: calls and events that worked, and those that gave up.
    const sources: Record<string, { ok: number; failed: number; retried: number }> = {};
    const bump = (s: string, k: "ok" | "failed" | "retried") => { (sources[s] ??= { ok: 0, failed: 0, retried: 0 })[k]++; };
    for (const l of logs) if (l.source_system !== "FOS_JOBS" && recent(l, since)) bump(String(l.source_system), l.status === "SUCCESS" ? "ok" : l.status === "RETRYING" ? "retried" : "failed");
    for (const e of events) if (recent(e, since)) bump(String(e.source_system), e.status === "PROCESSED" ? "ok" : e.status === "PROCESSING" ? "retried" : "failed");
    const jobs = JOB_STEPS.map((step) => {
      const runs = logs.filter((l) => l.source_system === "FOS_JOBS" && l.entity_id === step);
      const last = runs[0];
      const lastOk = runs.find((x) => x.status === "SUCCESS");
      return { step, name: JOB_LABEL[step], last_run: last ? at(last) : null, ok: last ? last.status === "SUCCESS" : null, error: last?.status === "SUCCESS" ? null : last?.error_message ?? null, last_success: lastOk ? at(lastOk) : null };
    });
    const problems = [...await Promise.all(dead.map((x) => problem(call, x, "log"))), ...await Promise.all(failed.map((x) => problem(call, x, "event")))]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return {
      zoho: integration ? {
        status: integration.status, dc: integration.zoho_dc ?? null, books_org: integration.org_id ?? null, projects_portal: integration.portal_id ?? null,
        // Presence only; secrets never leave the server.
        token_stored: !!integration.refresh_token, webhook_secret_stored: !!integration.webhook_secret,
      } : null,
      sources: Object.entries(sources).map(([source, c]) => ({ source, ...c })).sort((a, b) => a.source.localeCompare(b.source)),
      jobs, problems,
    };
  });

  r.on("POST", "/admin/integrations/retry", "integration.admin", async (call) => {
    const b = parse(target, call.body);
    const row = await load(call, b.kind, b.id);
    const zoho = await call.zoho();
    let outcome: unknown;
    if (b.kind === "log") {
      if (row.source_system !== "CRM" || row.entity_type !== "application") throw new AppError("VALIDATION_FAILED", "This item can't be retried; resolve it instead.", { id: "not retryable" });
      const app = await call.repo.findOne("franchise_applications", { ROWID: String(row.entity_id) });
      if (!app) throw new AppError("NOT_FOUND", "The application no longer exists; resolve this item instead.");
      if (!zoho?.crm) throw new AppError("ZOHO_SYNC_FAILED", "Zoho CRM is not connected for this tenant.");
      const okPush = await pushApplicationStatus(call.store, call.ctx, zoho.crm, app);
      // A failed attempt logs its own dead letter, which replaces this one.
      await call.repo.update("integration_logs", b.id, { status: "RESOLVED" });
      if (!okPush) throw new AppError("ZOHO_SYNC_FAILED", "CRM still refused the update. The new attempt is listed; check the error.");
      outcome = { pushed: true };
    } else {
      if (!zoho) throw new AppError("ZOHO_SYNC_FAILED", "Zoho is not connected for this tenant.");
      if (row.source_system === "CRM") {
        const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
        const settings = (() => { try { return JSON.parse(String(tenant?.settings_json ?? "{}")); } catch { return {}; } })();
        outcome = await handleCrmLead(call.store, call.ctx, zoho.crm, { leadId: String(row.record_id), triggerStatus: settings.crm_trigger_status ?? DEFAULT_CRM_TRIGGER_STATUS });
      } else if (row.source_system === "SIGN") {
        let payload: Row = {};
        try { payload = JSON.parse(String(row.payload_json || "{}")); } catch { payload = {}; }
        outcome = await handleSignEvent(call.store, call.ctx, zoho, { requestId: String(row.record_id), operation: (payload.operation as string) ?? undefined, onTransition: call.onTransition });
      } else {
        throw new AppError("VALIDATION_FAILED", "This item can't be retried; resolve it instead.", { id: "not retryable" });
      }
      // The lead may have changed since, which makes a new event; the old one is then settled.
      const again = await call.repo.findOne("integration_events", { ROWID: b.id });
      if (again?.status === "FAILED") await call.repo.update("integration_events", b.id, { status: "RESOLVED", error_message: `${String(again.error_message ?? "")} (retried as a newer event)`.slice(0, 500) });
    }
    await logActivity(call.store, call.ctx, { entityType: "integration", entityId: b.id, action: "integration:retried", metadata: { kind: b.kind, source: row.source_system, operation: row.operation ?? null, record_id: row.record_id ?? row.entity_id ?? null } });
    return { retried: true, outcome };
  });

  r.on("POST", "/admin/integrations/resolve", "integration.admin", async (call) => {
    const b = parse(resolveSchema, call.body);
    const row = await load(call, b.kind, b.id);
    await call.repo.update(b.kind === "log" ? "integration_logs" : "integration_events", b.id, { status: "RESOLVED" });
    await logActivity(call.store, call.ctx, { entityType: "integration", entityId: b.id, action: "integration:resolved", metadata: { kind: b.kind, source: row.source_system, error: row.error_message ?? null, reason: b.reason } });
    return { resolved: true };
  });
}
