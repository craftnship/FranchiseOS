import { randomUUID } from "crypto";
import { AppError } from "./errors";

// Envelope from spec §11 / §39.
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; fields?: Record<string, string> };
  meta: { request_id: string };
}

export function newRequestId(): string {
  return "REQ-" + randomUUID();
}

export function ok<T>(data: T, requestId: string): ApiResponse<T> {
  return { success: true, data, meta: { request_id: requestId } };
}

export function fail(err: unknown, requestId: string): { status: number; body: ApiResponse<never> } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        success: false,
        error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
        meta: { request_id: requestId },
      },
    };
  }
  // Never leak internals (§28): unknown errors become a generic 500.
  return {
    status: 500,
    body: {
      success: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
      meta: { request_id: requestId },
    },
  };
}
