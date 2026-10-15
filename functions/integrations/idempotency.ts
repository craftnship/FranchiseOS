import { AppError } from "../common/errors";
import { DuplicateKeyError, Row, Store } from "../common/store";

// Webhook idempotency (spec §14, §29, FOS-015). event_key is a unique column.
export function eventKey(source: string, eventId: string, recordId: string): string {
  return `${source}:${eventId}:${recordId}`;
}

// SDK errors are not always Error instances, so fall back to their JSON form.
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export type ProcessResult<T> = { duplicate: true } | { duplicate: false; result: T };

/** An event still PROCESSING after this long was cut off (a timed-out function) and may be taken over. */
export const STALE_AFTER_MS = 10 * 60_000;

const when = (v: unknown) => { const t = Date.parse(String(v ?? "").replace(" ", "T")); return Number.isFinite(t) ? t : null; };

/** True for a PROCESSING row whose last write is older than STALE_AFTER_MS. */
export function isStaleProcessing(row: Row, now = new Date()): boolean {
  if (row.status !== "PROCESSING") return false;
  const t = when(row.MODIFIEDTIME ?? row.CREATEDTIME);
  return t !== null && now.getTime() - t > STALE_AFTER_MS;
}

/**
 * Runs handler at most once per event. A duplicate of an event that is processed or in flight
 * returns { duplicate: true } so the webhook can answer 200 without repeating side effects.
 * A previously FAILED event, or one left PROCESSING by a function that died, may be retried.
 * With retakeDone, a PROCESSED event may run again too: the caller's own record then decides
 * whether the work is still due (a claim, not a webhook).
 */
export async function processOnce<T>(
  store: Store,
  tenantId: string,
  evt: { source: string; eventId: string; recordId: string; payload: unknown },
  handler: () => Promise<T>,
  opts: { alert?: boolean; now?: Date; retakeDone?: boolean } = {},
): Promise<ProcessResult<T>> {
  const key = eventKey(evt.source, evt.eventId, evt.recordId);
  let rowId: string;
  try {
    const row = await store.insert("integration_events", {
      tenant_id: tenantId,
      source_system: evt.source,
      event_id: evt.eventId,
      record_id: evt.recordId,
      event_key: key,
      status: "PROCESSING",
      payload_json: JSON.stringify(evt.payload).slice(0, 10_000),
    });
    rowId = String(row.ROWID);
  } catch (e) {
    if (!(e instanceof DuplicateKeyError)) throw e;
    const existing = await store.findOne("integration_events", { event_key: key });
    const retake = !!existing && (existing.status === "FAILED" || isStaleProcessing(existing, opts.now) || (!!opts.retakeDone && existing.status === "PROCESSED"));
    if (!existing || !retake) return { duplicate: true };
    rowId = String(existing.ROWID);
    await store.update("integration_events", rowId, { status: "PROCESSING" });
  }
  try {
    const result = await handler();
    await store.update("integration_events", rowId, { status: "PROCESSED", processed_at: new Date().toISOString() });
    return { duplicate: false, result };
  } catch (e) {
    await store.update("integration_events", rowId, { status: "FAILED", error_message: errorText(e).slice(0, 500) });
    if (opts.alert === false) throw e;
    const { alertAdmins } = await import("../workflows/systemAlerts");
    await alertAdmins(store, tenantId, {
      kind: "health.event_failed", entityType: "integration_event", entityId: rowId, dedupe: `event:${key}`,
      title: `${evt.source} event failed to process`,
      body: `${errorText(e).slice(0, 200)} Retry it from Integration health once the cause is fixed.`,
    });
    throw e;
  }
}


/**
 * Claims one piece of work (raising an invoice, say) before it calls Zoho, so two people clicking at
 * the same moment, or a person and the daily job, cannot both do it: the second caller is told to
 * refresh. The claim is the same integration_events row a webhook uses, so a claim that failed can be
 * taken again, and one cut off by a timed-out function frees itself after STALE_AFTER_MS. A finished
 * claim is history, not a lock: the record's own status (re-read inside `work`) decides whether the
 * work is due again, so a report sent back after approval can be approved a second time.
 */
export async function claim<T>(store: Store, tenantId: string, what: string, recordId: string, work: () => Promise<T>, now?: Date): Promise<T> {
  const r = await processOnce(store, tenantId, { source: "FOS", eventId: what, recordId, payload: null }, work, { alert: false, now, retakeDone: true });
  if (r.duplicate) throw new AppError("INVALID_TRANSITION", "Someone else is doing this right now; refresh in a moment.");
  return r.result;
}
