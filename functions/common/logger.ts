// Structured logging per spec §28. Secrets and tokens are redacted before output.
const REDACT_KEYS = /token|secret|password|authorization|refresh|client_secret/i;

export interface LogFields {
  request_id?: string;
  correlation_id?: string;
  tenant_id?: string;
  user_id?: string;
  service?: string;
  duration_ms?: number;
  status?: "success" | "failure";
  external_id?: string;
  error_code?: string;
  [key: string]: unknown;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEYS.test(k) ? "[REDACTED]" : redact(v);
    return out;
  }
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...(redact(fields) as object) });
  (level === "error" ? console.error : console.log)(line);
}
