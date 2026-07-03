/** @enum {string} */
export const LogLevel = Object.freeze({
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARN",
  ERROR: "ERROR",
  FATAL: "FATAL",
});

/** @enum {string} */
export const ActorType = Object.freeze({
  USER: "USER",
  SERVICE: "SERVICE",
  SYSTEM: "SYSTEM",
});

/** @enum {string} */
export const OutcomeType = Object.freeze({
    SUCCESS: 'SUCCESS',
    FAILURE: 'FAILURE',
    PARTIAL: 'PARTIAL',
});
// ── Validation helpers ────────────────────────────────────────────────────────

function requireString(obj, field) {
  if (typeof obj[field] !== "string" || obj[field].trim() === "") {
    throw new TypeError(`${field} is required and must be a non-empty string`);
  }
}

function requireEnum(obj, field, enumObj) {
  const valid = Object.values(enumObj);
  if (!valid.includes(obj[field])) {
    throw new TypeError(`${field} must be one of: ${valid.join(", ")}`);
  }
}

function toISOString(val, field) {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val; // pass-through — server validates
  throw new TypeError(`${field} must be a Date or ISO string`);
}

// ── App Log ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AppLogRequestData
 * @property {string} source_service
 * @property {string} environment
 * @property {string} level - one of LogLevel values
 * @property {string} message
 * @property {string} trace_id
 * @property {Date|string} created_at
 * @property {object|null} [context_json]
 */

export class AppLogRequest {
  /** @param {AppLogRequestData} data */
  constructor(data) {
    requireString(data, "source_service");
    requireString(data, "environment");
    requireEnum(data, "level", LogLevel);
    requireString(data, "message");
    requireString(data, "trace_id");

    this.source_service = data.source_service;
    this.environment = data.environment;
    this.level = data.level;
    this.message = data.message;
    this.trace_id = data.trace_id;
    this.created_at = toISOString(data.created_at ?? new Date(), "created_at");
    this.context_json = data.context_json ?? null;
  }

  toJSON() {
    return {
      source_service: this.source_service,
      environment: this.environment,
      level: this.level,
      message: this.message,
      trace_id: this.trace_id,
      created_at: this.created_at,
      context_json: this.context_json,
    };
  }
}

/**
 * @typedef {Object} AppLogResponse
 * @property {number} log_id
 * @property {string} ingested_at
 */

// ── Batch App Log ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BatchLogResult
 * @property {number} index
 * @property {boolean} success
 * @property {number|null} log_id
 * @property {string|null} error_code
 * @property {string|null} message
 */

/**
 * @typedef {Object} BatchAppLogResponse
 * @property {BatchLogResult[]} results
 * @property {number} total
 * @property {number} succeeded
 * @property {number} failed
 */

// ── Audit Log ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AuditLogRequestData
 * @property {string} source_service
 * @property {string} environment
 * @property {string} action
 * @property {string} actor_type - one of ActorType values
 * @property {string} target_resource
 * @property {string} outcome
 * @property {string} ip_address
 * @property {Date|string} event_time
 * @property {string|null} [actor_id]
 * @property {object|null} [detail_json]
 */

export class AuditLogRequest {
  /** @param {AuditLogRequestData} data */
  constructor(data) {
    requireString(data, "source_service");
    requireString(data, "environment");
    requireString(data, "action");
    requireEnum(data, "actor_type", ActorType);
    requireString(data, "target_resource");
    requireString(data, "outcome", OutcomeType);
    requireString(data, "ip_address");

    this.source_service = data.source_service;
    this.environment = data.environment;
    this.action = data.action;
    this.actor_type = data.actor_type;
    this.target_resource = data.target_resource;
    this.outcome = data.outcome;
    this.ip_address = data.ip_address;
    this.event_time = toISOString(data.event_time ?? new Date(), "event_time");
    this.actor_id = data.actor_id ?? null;
    this.detail_json = data.detail_json ?? null;
  }

  toJSON() {
    return {
      source_service: this.source_service,
      environment: this.environment,
      action: this.action,
      actor_type: this.actor_type,
      target_resource: this.target_resource,
      outcome: this.outcome,
      ip_address: this.ip_address,
      event_time: this.event_time,
      actor_id: this.actor_id,
      detail_json: this.detail_json,
    };
  }
}

/**
 * @typedef {Object} AuditLogResponse
 * @property {number} log_id
 * @property {string} ingested_at
 */
