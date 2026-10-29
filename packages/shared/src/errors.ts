/**
 * Error codes and HTTP statuses matching Directus 11.x (ADR-008, ADR-009).
 * Services throw CirrusError; the final middleware serializes it in Directus format:
 *   { "errors": [{ "message": "...", "extensions": { "code": "..." } }] }
 */
export const ERROR_STATUS = {
  FORBIDDEN: 403,
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  INVALID_OTP: 401,
  INVALID_PAYLOAD: 400,
  INVALID_QUERY: 400,
  INVALID_FOREIGN_KEY: 400,
  CONTAINS_NULL_VALUES: 400,
  VALUE_OUT_OF_RANGE: 400,
  VALUE_TOO_LONG: 400,
  NOT_NULL_VIOLATION: 400,
  RECORD_NOT_UNIQUE: 400,
  ROUTE_NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  REQUESTS_EXCEEDED: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type DirectusErrorBody = {
  errors: Array<{
    message: string;
    extensions: { code: ErrorCode } & Record<string, unknown>;
  }>;
};

export class CirrusError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extensions: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, extensions: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CirrusError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.extensions = extensions;
  }

  toBody(): DirectusErrorBody {
    return {
      errors: [{ message: this.message, extensions: { ...this.extensions, code: this.code } }],
    };
  }
}

export const isCirrusError = (e: unknown): e is CirrusError => e instanceof CirrusError;

/** Directus InvalidPayloadError: "Invalid payload. <reason>." with extensions.reason. */
export const invalidPayload = (reason: string) =>
  new CirrusError('INVALID_PAYLOAD', `Invalid payload. ${reason}.`, { reason });

/** Directus ForbiddenError. Also used for things that don't exist, so their existence isn't leaked. */
export const forbidden = () => new CirrusError('FORBIDDEN', "You don't have permission to access this.");
