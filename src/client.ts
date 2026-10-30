import {
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
  type ErrorBody,
} from './errors.js'
import {
  AppLogRequest,
  AuditLogRequest,
  type ActorType,
  type AppLogRequestData,
  type AuditLogRequestData,
  type BatchAppLogResponse,
  type IngestResponse,
  type LogLevel,
  type Outcome,
} from './models.js'
import { generateSignature } from './signing.js'
import { VERSION } from './version.js'

const APP_PATH = '/api/v1/logs/app'
const BATCH_PATH = '/api/v1/logs/app/batch'
const AUDIT_PATH = '/api/v1/logs/audit'
const MAX_BATCH = 100
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

type FetchLike = (input: string, init: RequestInit) => Promise<Response>
type Entry = { kind: 'app'; entry: AppLogRequest } | { kind: 'audit'; entry: AuditLogRequest }

/** Receives buffered-mode failures. `entry` is the request (or the raw input if it failed validation). */
export type ErrorHandler = (error: Error, entry: AppLogRequest | AuditLogRequest | unknown) => void

export interface LMSClientOptions {
  /** LMS address, e.g. `https://lms.example.com`. */
  baseUrl: string
  /** The LMS `INGEST_SIGNING_SECRET`. */
  secret: string
  /** Registered service id; default for every entry. */
  sourceService?: string
  /** e.g. `production`; default for every entry. */
  environment?: string
  /** Per-request timeout in ms. Default 10 000. */
  timeout?: number
  /** Retries after the first attempt (network errors, 5xx, 429). Default 3. */
  maxRetries?: number
  /** Base backoff in ms (exponential, jittered). Default 500. */
  backoff?: number
  /** Backoff cap in ms (also caps Retry-After). Default 30 000. */
  maxBackoff?: number
  /** Queue entries and ship them in the background. Methods never throw. Default false. */
  buffered?: boolean
  /** Buffered mode: entries per batch request (1–100). Default 50. */
  batchSize?: number
  /** Buffered mode: max ms an entry waits before being sent. Default 2 000. */
  flushInterval?: number
  /** Buffered mode: entries kept in memory before dropping. Default 10 000. */
  maxQueue?: number
  /** Buffered mode: receives every delivery failure / dropped entry. */
  onError?: ErrorHandler
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** Custom fetch implementation (tests, proxies). Defaults to global fetch. */
  fetch?: FetchLike
  /** @deprecated never sent to the server; use `sourceService`. */
  serviceId?: string
}

export interface LogOptions {
  traceId?: string
  createdAt?: Date | string
  sourceService?: string
  environment?: string
}

export interface AuditInput {
  actorId: string
  actorType: ActorType | Lowercase<ActorType>
  action: string
  targetResource: string
  outcome: Outcome | Lowercase<Outcome>
  ipAddress?: string
  detail?: Record<string, unknown>
  eventTime?: Date | string
  sourceService?: string
  environment?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Client for the Voicollo LMS ingestion API.
 *
 * ```ts
 * const lms = new LMSClient({
 *   baseUrl: process.env.LMS_URL!, secret: process.env.LMS_INGEST_SECRET!,
 *   sourceService: 'billing-api', environment: 'production', buffered: true,
 * })
 * lms.info('Payment captured', { orderId: 42 })
 * await lms.close()
 * ```
 */
export class LMSClient {
  /** Package version, also sent as `User-Agent: lms-logger-js/<version>`. */
  static readonly VERSION = VERSION

  readonly sourceService?: string
  readonly environment?: string
  readonly buffered: boolean
  /** Buffered mode: number of entries dropped because the queue was full. */
  dropped = 0

  private readonly base: string
  private readonly secret: string
  private readonly timeout: number
  private readonly maxRetries: number
  private readonly backoff: number
  private readonly maxBackoff: number
  private readonly batchSize: number
  private readonly flushInterval: number
  private readonly maxQueue: number
  private readonly onError?: ErrorHandler
  private readonly headers: Record<string, string>
  private readonly fetchImpl: FetchLike
  private lastTimestamp = 0

  private queue: Entry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining: Promise<void> | null = null
  private closed = false
  private readonly onBeforeExit = () => void this.flush()

  constructor(options: LMSClientOptions) {
    if (!options?.baseUrl) throw new LMSConfigError('baseUrl is required')
    if (!options.secret) throw new LMSConfigError('secret is required (the LMS INGEST_SIGNING_SECRET)')
    if (options.serviceId !== undefined) {
      process.emitWarning('lms-logger: `serviceId` is deprecated; use `sourceService`.', 'DeprecationWarning')
    }
    this.base = options.baseUrl.replace(/\/+$/, '')
    this.secret = options.secret
    this.sourceService = options.sourceService ?? options.serviceId
    this.environment = options.environment
    this.timeout = options.timeout ?? 10_000
    this.maxRetries = options.maxRetries ?? 3
    this.backoff = options.backoff ?? 500
    this.maxBackoff = options.maxBackoff ?? 30_000
    this.buffered = options.buffered ?? false
    this.batchSize = options.batchSize ?? 50
    this.flushInterval = options.flushInterval ?? 2_000
    this.maxQueue = options.maxQueue ?? 10_000
    this.onError = options.onError
    this.headers = options.headers ?? {}
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (!fetchImpl) throw new LMSConfigError('global fetch is unavailable; use Node >= 18 or pass `fetch`')
    this.fetchImpl = fetchImpl
    if (this.maxRetries < 0) throw new LMSConfigError('maxRetries must be >= 0')
    if (this.batchSize < 1 || this.batchSize > MAX_BATCH) {
      throw new LMSConfigError(`batchSize must be between 1 and ${MAX_BATCH}`)
    }
    if (this.buffered) process.once('beforeExit', this.onBeforeExit)
  }

  /** @deprecated alias of `sourceService` */
  get serviceId(): string | undefined {
    return this.sourceService
  }

  // ---------------------------------------------------------------- transport
  private sign(body: string): Record<string, string> {
    // Strictly increasing per client: a retry is never byte-identical to an
    // earlier attempt, so the server cannot reject it as a replay.
    const ts = Math.max(Math.floor(Date.now() / 1000), this.lastTimestamp + 1)
    this.lastTimestamp = ts
    const stamp = String(ts)
    return { 'X-Timestamp': stamp, 'X-Signature': generateSignature(this.secret, body, stamp) }
  }

  private delay(attempt: number, response: Response | null): number {
    if (response?.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'))
      if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, this.maxBackoff)
    }
    const base = Math.min(this.maxBackoff, this.backoff * 2 ** (attempt - 1))
    return base * (0.5 + Math.random() / 2)
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload)
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      let response: Response | null = null
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)
      try {
        response = await this.fetchImpl(`${this.base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': `lms-logger-js/${VERSION}`,
            ...this.headers,
            ...this.sign(body),
          },
          body,
          signal: controller.signal,
        })
      } catch (err) {
        lastError = err
      } finally {
        clearTimeout(timer)
      }
      if (response) {
        if (response.ok) return (await response.json()) as T
        const error = await toError(response)
        if (!RETRY_STATUSES.has(response.status)) throw error
        lastError = error
      }
      if (attempt > this.maxRetries) break
      await sleep(this.delay(attempt, response))
    }
    if (lastError instanceof LMSError) throw lastError
    const reason = lastError instanceof Error ? lastError.message : String(lastError)
    throw new LMSConnectionError(`LMS unreachable after ${this.maxRetries + 1} attempts: ${reason}`, null, {}, {
      cause: lastError,
    })
  }

  private withDefaults<E extends AppLogRequest | AuditLogRequest>(entry: E): E {
    entry.source_service ??= this.sourceService
    entry.environment ??= this.environment
    entry.toJSON() // validates required fields now, not later in the background
    return entry
  }

  // ---------------------------------------------------------------- explicit API
  /**
   * In buffered mode an invalid entry is reported to `onError` instead of
   * rejecting — callers do not await, and an unhandled rejection would crash Node.
   */
  private build<E>(make: () => E, raw: unknown): E | undefined {
    try {
      return make()
    } catch (err) {
      if (!this.buffered) throw err
      this.report(err as Error, raw)
      return undefined
    }
  }

  /** Send one application log. Resolves `undefined` in buffered mode. */
  async logApp(request: AppLogRequest | AppLogRequestData): Promise<IngestResponse | undefined> {
    const entry = this.build(
      () => this.withDefaults(request instanceof AppLogRequest ? request : new AppLogRequest(request)),
      request,
    )
    if (!entry) return undefined
    if (this.buffered) return void this.enqueue({ kind: 'app', entry })
    return this.post<IngestResponse>(APP_PATH, entry.toJSON())
  }

  /** Send up to 100 entries in one request (always immediate). Check `failed`/`results`. */
  async logAppBatch(requests: (AppLogRequest | AppLogRequestData)[]): Promise<BatchAppLogResponse> {
    if (!requests.length) throw new LMSConfigError('logAppBatch needs at least one entry')
    if (requests.length > MAX_BATCH) throw new LMSConfigError(`at most ${MAX_BATCH} entries per batch`)
    const entries = requests.map((r) => this.withDefaults(r instanceof AppLogRequest ? r : new AppLogRequest(r)))
    return this.post<BatchAppLogResponse>(BATCH_PATH, { logs: entries.map((e) => e.toJSON()) })
  }

  /** Send one audit log. Resolves `undefined` in buffered mode. */
  async logAudit(request: AuditLogRequest | AuditLogRequestData): Promise<IngestResponse | undefined> {
    const entry = this.build(
      () => this.withDefaults(request instanceof AuditLogRequest ? request : new AuditLogRequest(request)),
      request,
    )
    if (!entry) return undefined
    if (this.buffered) return void this.enqueue({ kind: 'audit', entry })
    return this.post<IngestResponse>(AUDIT_PATH, entry.toJSON())
  }

  // ---------------------------------------------------------------- convenience
  async log(
    level: LogLevel | Lowercase<LogLevel> | 'WARNING' | 'warning',
    message: string,
    context?: Record<string, unknown>,
    options: LogOptions = {},
  ): Promise<IngestResponse | undefined> {
    return this.logApp({
      level,
      message,
      context_json: context,
      trace_id: options.traceId,
      created_at: options.createdAt,
      source_service: options.sourceService,
      environment: options.environment,
    })
  }

  debug(message: string, context?: Record<string, unknown>, options?: LogOptions) {
    return this.log('DEBUG', message, context, options)
  }
  info(message: string, context?: Record<string, unknown>, options?: LogOptions) {
    return this.log('INFO', message, context, options)
  }
  warn(message: string, context?: Record<string, unknown>, options?: LogOptions) {
    return this.log('WARN', message, context, options)
  }
  error(message: string, context?: Record<string, unknown>, options?: LogOptions) {
    return this.log('ERROR', message, context, options)
  }
  fatal(message: string, context?: Record<string, unknown>, options?: LogOptions) {
    return this.log('FATAL', message, context, options)
  }

  async audit(input: AuditInput): Promise<IngestResponse | undefined> {
    return this.logAudit({
      actor_id: input.actorId,
      actor_type: input.actorType,
      action: input.action,
      target_resource: input.targetResource,
      outcome: input.outcome,
      ip_address: input.ipAddress,
      detail_json: input.detail,
      event_time: input.eventTime,
      source_service: input.sourceService,
      environment: input.environment,
    })
  }

  // ---------------------------------------------------------------- buffering
  private report(error: Error, entry: unknown): void {
    if (this.onError) {
      try {
        this.onError(error, entry)
        return
      } catch {
        /* a broken callback must not break logging */
      }
    }
    process.emitWarning(`lms-logger dropped a log entry: ${error.message}`, 'LMSLoggerWarning')
  }

  private enqueue(item: Entry): void {
    if (this.closed) {
      this.report(new LMSError('client is closed'), item.entry)
      return
    }
    if (this.queue.length >= this.maxQueue) {
      this.dropped++
      this.report(new LMSQueueFullError('lms-logger queue is full'), item.entry)
      return
    }
    this.queue.push(item)
    if (this.queue.length >= this.batchSize) void this.drain()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.drain(), this.flushInterval)
      this.timer.unref?.()
    }
  }

  private drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.draining ??= (async () => {
      try {
        while (this.queue.length) {
          const chunk = this.queue.splice(0, this.batchSize)
          await this.ship(chunk)
        }
      } finally {
        this.draining = null
      }
    })()
    return this.draining
  }

  private async ship(items: Entry[]): Promise<void> {
    const apps = items.filter((i) => i.kind === 'app').map((i) => i.entry as AppLogRequest)
    const audits = items.filter((i) => i.kind === 'audit').map((i) => i.entry as AuditLogRequest)
    try {
      if (apps.length === 1) await this.post(APP_PATH, apps[0].toJSON())
      else if (apps.length > 1) {
        const result = await this.post<BatchAppLogResponse>(BATCH_PATH, { logs: apps.map((e) => e.toJSON()) })
        for (const r of result.results) {
          if (!r.success) {
            this.report(new LMSError(r.message ?? 'entry rejected', null, {}, { errorCode: r.error_code }), apps[r.index])
          }
        }
      }
    } catch (err) {
      for (const entry of apps) this.report(err as Error, entry)
    }
    for (const entry of audits) {
      try {
        await this.post(AUDIT_PATH, entry.toJSON())
      } catch (err) {
        this.report(err as Error, entry)
      }
    }
  }

  /** Buffered mode: send everything queued so far. Never rejects. */
  async flush(): Promise<void> {
    while (this.queue.length || this.draining) await this.drain()
  }

  /** Flush (buffered mode) and stop accepting entries. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return
    await this.flush()
    this.closed = true
    process.removeListener('beforeExit', this.onBeforeExit)
  }
}

async function toError(response: Response): Promise<LMSError> {
  let body: ErrorBody = {}
  try {
    const parsed: unknown = await response.json()
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ErrorBody) : { raw: parsed }
  } catch {
    /* non-JSON error body */
  }
  const message = String(body.message ?? body.detail ?? (response.statusText || `HTTP ${response.status}`))
  switch (response.status) {
    case 401:
      return new LMSAuthError(message, 401, body)
    case 403:
      return new LMSPermissionError(message, 403, body)
    case 404:
      return new LMSNotFoundError(message, 404, body)
    case 409:
      return new LMSConflictError(message, 409, body)
    case 422:
      return new LMSValidationError(message, 422, body)
    case 429: {
      const retryAfter = Number(response.headers.get('Retry-After'))
      return new LMSRateLimitError(message, 429, body, Number.isFinite(retryAfter) ? retryAfter : null)
    }
    default:
      return response.status >= 500
        ? new LMSServerError(message, response.status, body)
        : new LMSError(message, response.status, body)
  }
}
