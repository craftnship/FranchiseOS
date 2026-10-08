import { DuplicateKeyError, Store } from "../common/store";

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

/**
 * Runs handler at most once per event. A duplicate of an event that is processed or in flight
 * returns { duplicate: true } so the webhook can answer 200 without repeating side effects.
 * A previously FAILED event may be retried.
 */
export async function processOnce<T>(
  store: Store,
  tenantId: string,
  evt: { source: string; eventId: string; recordId: string; payload: unknown },
  handler: () => Promise<T>,
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
    if (!existing || existing.status !== "FAILED") return { duplicate: true };
    rowId = String(existing.ROWID);
    await store.update("integration_events", rowId, { status: "PROCESSING" });
  }
  try {
    const result = await handler();
    await store.update("integration_events", rowId, { status: "PROCESSED", processed_at: new Date().toISOString() });
    return { duplicate: false, result };
  } catch (e) {
    await store.update("integration_events", rowId, { status: "FAILED", error_message: errorText(e).slice(0, 500) });
    throw e;
  }
}
