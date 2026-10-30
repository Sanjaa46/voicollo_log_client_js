export { LMSClient } from './client.js'
export type { AuditInput, ErrorHandler, LMSClientOptions, LogOptions } from './client.js'
export {
  ActorType,
  AppLogRequest,
  AuditLogRequest,
  LogLevel,
  Outcome,
  OutcomeType,
} from './models.js'
export type {
  AppLogPayload,
  AppLogRequestData,
  AppLogResponse,
  AuditLogPayload,
  AuditLogRequestData,
  AuditLogResponse,
  BatchAppLogResponse,
  BatchLogResult,
  IngestResponse,
} from './models.js'
export {
  LMSAuthError,
  LMSConfigError,
  LMSConflictError,
  LMSConnectionError,
  LMSError,
  LMSNotFoundError,
  LMSPermissionError,
  LMSQueueFullError,
  LMSRateLimitError,
  LMSServerError,
  LMSValidationError,
} from './errors.js'
export type { ErrorBody } from './errors.js'
export { currentTimestamp, generateSignature } from './signing.js'
export { VERSION } from './version.js'
