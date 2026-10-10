// Error codes from spec §27, plus codes needed by accepted decisions D-4, D-15 and D-22.
export const ERROR_CODES = {
  AUTH_REQUIRED: 401,
  ACCESS_DENIED: 403,
  TENANT_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  FRANCHISEE_NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  APPLICATION_NOT_FOUND: 404,
  APPLICATION_INVALID_STATE: 409,
  APPLICATION_DOCUMENT_MISSING: 422,
  TERRITORY_NOT_FOUND: 404,
  TERRITORY_NOT_AVAILABLE: 409,
  TERRITORY_CONFLICT: 409,
  SITE_NOT_FOUND: 404,
  SITE_EVALUATION_INCOMPLETE: 422,
  FEASIBILITY_NOT_FOUND: 404,
  FEASIBILITY_FAILED: 422,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_NOT_ALLOWED: 403,
  APPROVAL_ALREADY_COMPLETED: 409,
  AGREEMENT_NOT_FOUND: 404,
  AGREEMENT_ALREADY_SIGNED: 409,
  PROJECT_CREATION_FAILED: 502,
  ZOHO_SYNC_FAILED: 502,
  INVALID_TRANSITION: 409,
  FILE_STORAGE_UNAVAILABLE: 503,
  WEBHOOK_SIGNATURE_INVALID: 401,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, message?: string, fields?: Record<string, string>) {
    super(message ?? defaultMessage(code));
    this.code = code;
    this.status = ERROR_CODES[code];
    this.fields = fields;
  }
}

function defaultMessage(code: ErrorCode): string {
  const words = code.toLowerCase().split("_");
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
}

export function assertFound<T>(value: T | null | undefined, code: ErrorCode): T {
  if (value === null || value === undefined) throw new AppError(code);
  return value;
}
