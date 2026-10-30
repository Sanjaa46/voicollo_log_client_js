import { isIP } from 'node:net'
import { LMSConfigError } from './errors.js'

export const LogLevel = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  /** Alias of WARN. */
  WARNING: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
  /** Alias of FATAL. */
  CRITICAL: 'FATAL',
} as const)
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export const ActorType = Object.freeze({ USER: 'USER', SERVICE: 'SERVICE', SYSTEM: 'SYSTEM' } as const)
export type ActorType = (typeof ActorType)[keyof typeof ActorType]

export const Outcome = Object.freeze({ SUCCESS: 'SUCCESS', FAILURE: 'FAILURE', PARTIAL: 'PARTIAL' } as const)
export type Outcome = (typeof Outcome)[keyof typeof Outcome]
/** @deprecated use `Outcome` */
export const OutcomeType = Outcome

type JsonObject = Record<string, unknown>

const LEVEL_ALIASES: Record<string, LogLevel> = {
  DEBUG: 'DEBUG',
  TRACE: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  WARNING: 'WARN',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  FATAL: 'FATAL',
  CRITICAL: 'FATAL',
}

// ------------------------------------------------------------------ validators
function fail(field: string, message: string): never {
  throw new LMSConfigError(`${field} ${message}`)
}

function str(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) fail(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string') fail(field, 'must be a string')
  const trimmed = value.trim()
  if (!trimmed) fail(field, 'must not be blank')
  if (trimmed.length > max) fail(field, `must be at most ${max} characters`)
  return trimmed
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : value
  if (!allowed.includes(upper as T)) fail(field, `must be one of ${allowed.join(', ')}`)
  return upper as T
}

function level(value: unknown): LogLevel {
  const resolved = typeof value === 'string' ? LEVEL_ALIASES[value.trim().toUpperCase()] : undefined
  if (!resolved) fail('level', `must be one of DEBUG, INFO, WARN, ERROR, FATAL (got ${String(value)})`)
  return resolved
}

function timestamp(value: unknown, field: string): string {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail(field, 'must be a Date or an ISO-8601 string')
  return date.toISOString()
}

function object(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be a plain object')
  return value as JsonObject
}

// ------------------------------------------------------------------ app log
export interface AppLogRequestData {
  level: LogLevel | Lowercase<LogLevel> | 'WARNING' | 'warning'
  message: string
  /** Defaults to the client's `sourceService`. */
  source_service?: string
  /** Defaults to the client's `environment`. */
  environment?: string
  trace_id?: string | null
  /** Defaults to now. */
  created_at?: Date | string
  context_json?: JsonObject | null
}

export interface AppLogPayload {
  source_service: string
  environment: string
  level: LogLevel
  message: string
  created_at: string
  trace_id?: string
  context_json?: JsonObject
}

/** A validated application log entry (wire format is snake_case). */
export class AppLogRequest {
  source_service?: string
  environment?: string
  readonly level: LogLevel
  readonly message: string
  readonly trace_id?: string
  readonly created_at: string
  readonly context_json?: JsonObject

  constructor(data: AppLogRequestData) {
    this.level = level(data.level)
    if (typeof data.message !== 'string' || !data.message.trim()) fail('message', 'must be a non-empty string')
    if (data.message.length > 65_000) fail('message', 'must be at most 65000 characters')
    this.message = data.message
    this.source_service = str(data.source_service, 'source_service', 64, false)
    this.environment = str(data.environment, 'environment', 32, false)
    this.trace_id = str(data.trace_id, 'trace_id', 64, false)
    this.created_at = timestamp(data.created_at, 'created_at')
    this.context_json = object(data.context_json, 'context_json')
  }

  toJSON(): AppLogPayload {
    if (!this.source_service) fail('source_service', 'is required (set it on the client or the entry)')
    if (!this.environment) fail('environment', 'is required (set it on the client or the entry)')
    return {
      source_service: this.source_service,
      environment: this.environment,
      level: this.level,
      message: this.message,
      created_at: this.created_at,
      ...(this.trace_id ? { trace_id: this.trace_id } : {}),
      ...(this.context_json ? { context_json: this.context_json } : {}),
    }
  }
}

// ------------------------------------------------------------------ audit log
export interface AuditLogRequestData {
  actor_id: string
  actor_type: ActorType | Lowercase<ActorType>
  /** VERB_NOUN, e.g. USER_LOGIN. Upper-cased automatically. */
  action: string
  target_resource: string
  outcome: Outcome | Lowercase<Outcome>
  source_service?: string
  environment?: string
  ip_address?: string | null
  event_time?: Date | string
  detail_json?: JsonObject | null
}

export interface AuditLogPayload {
  source_service: string
  environment: string
  actor_id: string
  actor_type: ActorType
  action: string
  target_resource: string
  outcome: Outcome
  event_time: string
  ip_address?: string
  detail_json?: JsonObject
}

/** A validated audit log entry (immutable once stored by the LMS). */
export class AuditLogRequest {
  source_service?: string
  environment?: string
  readonly actor_id: string
  readonly actor_type: ActorType
  readonly action: string
  readonly target_resource: string
  readonly outcome: Outcome
  readonly ip_address?: string
  readonly event_time: string
  readonly detail_json?: JsonObject

  constructor(data: AuditLogRequestData) {
    this.actor_id = str(data.actor_id, 'actor_id', 128, true)!
    this.actor_type = oneOf(data.actor_type, 'actor_type', Object.values(ActorType))
    const action = str(data.action, 'action', 128, true)!
    if (/\s/.test(action)) fail('action', 'must be VERB_NOUN without spaces, e.g. USER_LOGIN')
    this.action = action.toUpperCase()
    this.target_resource = str(data.target_resource, 'target_resource', 256, true)!
    this.outcome = oneOf(data.outcome, 'outcome', Object.values(Outcome))
    this.source_service = str(data.source_service, 'source_service', 64, false)
    this.environment = str(data.environment, 'environment', 32, false)
    const ip = str(data.ip_address, 'ip_address', 45, false)
    if (ip && !isIP(ip)) fail('ip_address', 'must be a valid IPv4 or IPv6 address')
    this.ip_address = ip
    this.event_time = timestamp(data.event_time, 'event_time')
    this.detail_json = object(data.detail_json, 'detail_json')
  }

  toJSON(): AuditLogPayload {
    if (!this.source_service) fail('source_service', 'is required (set it on the client or the entry)')
    if (!this.environment) fail('environment', 'is required (set it on the client or the entry)')
    return {
      source_service: this.source_service,
      environment: this.environment,
      actor_id: this.actor_id,
      actor_type: this.actor_type,
      action: this.action,
      target_resource: this.target_resource,
      outcome: this.outcome,
      event_time: this.event_time,
      ...(this.ip_address ? { ip_address: this.ip_address } : {}),
      ...(this.detail_json ? { detail_json: this.detail_json } : {}),
    }
  }
}

// ------------------------------------------------------------------ responses
export interface IngestResponse {
  log_id: number
  /** ISO-8601 UTC */
  ingested_at: string
}
export type AppLogResponse = IngestResponse
export type AuditLogResponse = IngestResponse

export interface BatchLogResult {
  index: number
  success: boolean
  log_id: number | null
  error_code: string | null
  message: string | null
}

export interface BatchAppLogResponse {
  results: BatchLogResult[]
  total: number
  succeeded: number
  failed: number
}
