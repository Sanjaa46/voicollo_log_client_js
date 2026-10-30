export interface ErrorBody {
  error_code?: string
  message?: string
  details?: Record<string, unknown> | null
  request_id?: string
  [key: string]: unknown
}

/** Base class for every error thrown by the client. */
export class LMSError extends Error {
  /** HTTP status, or `null` when the request never got a response. */
  readonly statusCode: number | null
  /** Machine-readable code from the LMS, e.g. `SERVICE_DISABLED`. */
  readonly errorCode: string | null
  /** Server request id — quote it when reporting a problem. */
  readonly requestId: string | null
  readonly responseBody: ErrorBody

  constructor(
    message: string,
    statusCode: number | null = null,
    responseBody: ErrorBody = {},
    options: { errorCode?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.statusCode = statusCode
    this.responseBody = responseBody
    this.errorCode = options.errorCode ?? responseBody.error_code ?? null
    this.requestId = responseBody.request_id ?? null
  }

  override toString(): string {
    return `${this.name}(statusCode=${this.statusCode}, errorCode=${this.errorCode}, message=${this.message})`
  }
}

/** Missing or invalid client configuration / entry field (thrown before any request). */
export class LMSConfigError extends LMSError {}
/** 401 — wrong secret, or the producer clock is off (`SIGNATURE_EXPIRED`). */
export class LMSAuthError extends LMSError {}
/** 403 — e.g. `SERVICE_DISABLED`. */
export class LMSPermissionError extends LMSError {}
/** 404 — unknown endpoint; check `baseUrl`. */
export class LMSNotFoundError extends LMSError {}
/** 409 — `DUPLICATE_REQUEST` (replayed signature). */
export class LMSConflictError extends LMSError {}
/** 422 — invalid payload or `SERVICE_NOT_REGISTERED`. */
export class LMSValidationError extends LMSError {}
/** 429 — rate limited. `retryAfter` is in seconds. */
export class LMSRateLimitError extends LMSError {
  readonly retryAfter: number | null
  constructor(message: string, statusCode: number, body: ErrorBody, retryAfter: number | null) {
    super(message, statusCode, body)
    this.retryAfter = retryAfter
  }
}
/** 5xx after all retries. */
export class LMSServerError extends LMSError {}
/** Network failure or timeout after all retries. */
export class LMSConnectionError extends LMSError {}
/** Buffered mode: the queue was full and the entry was dropped. */
export class LMSQueueFullError extends LMSError {}
