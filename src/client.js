import { generateSignature, currentTimestamp } from "./signing.js";
import {
  LMSError,
  LMSAuthError,
  LMSRateLimitError,
  LMSValidationError,
  LMSConnectionError,
} from "./exceptions.js";
import { AppLogRequest, AuditLogRequest } from "./models.js";

const STATUS_MAP = {
  401: LMSAuthError,
  429: LMSRateLimitError,
  422: LMSValidationError,
};

/**
 * @param {Response} response
 */
async function raiseForStatus(response) {
  if (response.ok) return;
  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text().catch(() => "") };
  }
  const ExcClass = STATUS_MAP[response.status] ?? LMSError;
  const message = body?.detail ?? body?.message ?? String(response.status);
  throw new ExcClass(message, response.status, body);
}

/**
 * Build HMAC-signed headers for a request body.
 *
 * @param {string} secret
 * @param {Buffer} body
 * @returns {Record<string, string>}
 */
function signedHeaders(secret, body) {
  const ts = currentTimestamp();
  const sig = generateSignature(secret, body, ts);
  return {
    "Content-Type": "application/json",
    "x-timestamp": ts,
    "x-signature": sig,
  };
}

// ── LMSClient (async — JS is always async) ───────────────────────────────────

/**
 * LMS client.
 *
 * JS has no meaningful sync HTTP, so both the "sync" and "async" Python clients
 * collapse into one async class here. All methods return Promises.
 *
 * Usage:
 *
 *   import { LMSClient, AppLogRequest, LogLevel } from "lms-logger";
 *
 *   const client = new LMSClient({
 *     baseUrl: "https://lms.example.mn",
 *     serviceId: "your32charhexserviceid",
 *     secret: "your-hmac-secret",
 *   });
 *
 *   await client.logApp(new AppLogRequest({
 *     source_service: "my-service",
 *     environment: "production",
 *     level: LogLevel.INFO,
 *     message: "Service started",
 *     trace_id: "abc123",
 *   }));
 *
 *   // Always close when done (no-op currently, kept for API parity)
 *   client.close();
 */
export class LMSClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.serviceId
   * @param {string} opts.secret
   * @param {number} [opts.timeout=10000] - ms
   * @param {number} [opts.maxRetries=3]
   */
  constructor({ baseUrl, serviceId, secret, timeout = 10_000, maxRetries = 3 }) {
    this.serviceId = serviceId;
    this._secret = secret;
    this._base = baseUrl.replace(/\/$/, "");
    this._timeout = timeout;
    this._maxRetries = maxRetries;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  /**
   * @param {string} path
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async _post(path, payload) {
    const bodyStr = JSON.stringify(payload);
    const bodyBuf = Buffer.from(bodyStr, "utf8");
    const headers = signedHeaders(this._secret, bodyBuf);
    const url = `${this._base}${path}`;
    let lastError;

    for (let attempt = 1; attempt <= this._maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeout);

        let response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers,
            body: bodyStr,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        await raiseForStatus(response);
        return await response.json();
      } catch (err) {
        // Never retry 4xx LMS errors
        if (err instanceof LMSRateLimitError) throw err;
        if (err instanceof LMSError) throw err;

        // Network / timeout errors → retry
        lastError = err;
        if (attempt < this._maxRetries) {
          console.warn(`[lms-logger] Attempt ${attempt}/${this._maxRetries} failed: ${err.message}`);
        }
      }
    }

    throw new LMSConnectionError(
      `LMS unreachable after ${this._maxRetries} attempts: ${lastError?.message}`,
    );
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Send a single application log entry.
   * @param {AppLogRequest} request
   * @returns {Promise<{log_id: number, ingested_at: string}>}
   */
  async logApp(request) {
    const data = await this._post("/api/v1/logs/app", request.toJSON());
    return data;
  }

  /**
   * Send multiple application log entries in one HTTP call.
   * @param {AppLogRequest[]} requests
   * @returns {Promise<{results: object[], total: number, succeeded: number, failed: number}>}
   */
  async logAppBatch(requests) {
    const data = await this._post("/api/v1/logs/app/batch", {
      logs: requests.map((r) => r.toJSON()),
    });
    return data;
  }

  /**
   * Send an audit log entry (immutable — DELETE is blocked by LMS).
   * @param {AuditLogRequest} request
   * @returns {Promise<{log_id: number, ingested_at: string}>}
   */
  async logAudit(request) {
    const data = await this._post("/api/v1/logs/audit", request.toJSON());
    return data;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** No-op. Kept for API symmetry with the Python client. */
  close() {}
}
