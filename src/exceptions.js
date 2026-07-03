export class LMSError extends Error {
  /**
   * @param {string} message
   * @param {number|null} statusCode
   * @param {object} responseBody
   */
  constructor(message, statusCode = null, responseBody = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toString() {
    return `${this.name}(statusCode=${this.statusCode}, message=${this.message})`;
  }
}

/** Raised on 401 — invalid or missing HMAC signature. */
export class LMSAuthError extends LMSError {}

/** Raised on 429 — service is being throttled by LMS. */
export class LMSRateLimitError extends LMSError {}

/** Raised on 422 — request payload failed schema validation. */
export class LMSValidationError extends LMSError {}

/** Raised when the LMS endpoint is unreachable after all retries. */
export class LMSConnectionError extends LMSError {}
