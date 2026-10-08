import { Store } from "../common/store";

// Retry with exponential backoff; terminal failures become DEAD_LETTER (spec §29).
export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = isRetryableStatus(status)) {
    super(message);
  }
}

export function isRetryableStatus(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export function backoffMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // jittered
}

export interface RetryLog {
  store: Store;
  tenantId: string;
  sourceSystem: string;
  entityType: string;
  entityId: string;
  operation: string;
  requestId: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  log: RetryLog,
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; baseMs?: number } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fn();
      await record(log, attempt, "SUCCESS");
      return result;
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : true;
      const terminal = !retryable || attempt >= max;
      await record(log, attempt, terminal ? "DEAD_LETTER" : "RETRYING", e);
      if (terminal) throw e;
      await sleep(backoffMs(attempt, opts.baseMs));
    }
  }
}

async function record(log: RetryLog, attempt: number, status: string, err?: unknown): Promise<void> {
  await log.store.insert("integration_logs", {
    tenant_id: log.tenantId,
    source_system: log.sourceSystem,
    entity_type: log.entityType,
    entity_id: log.entityId,
    operation: log.operation,
    status,
    attempt,
    request_id: log.requestId,
    error_code: err instanceof ProviderError ? String(err.status ?? "NETWORK") : err ? "UNKNOWN" : null,
    error_message: err ? String((err as Error).message).slice(0, 500) : null,
  });
}
