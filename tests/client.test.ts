import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppLogRequest,
  AuditLogRequest,
  LMSAuthError,
  LMSClient,
  LMSConfigError,
  LMSConnectionError,
  LMSPermissionError,
  LMSRateLimitError,
  LMSServerError,
  LMSValidationError,
  LogLevel,
  VERSION,
  generateSignature,
} from '../src/index.js'

const BASE = 'https://lms.test'
const SECRET = 'test-ingest-secret'

type Call = { url: string; init: RequestInit; body: Record<string, unknown> }

/** Fake fetch that verifies signatures exactly like the LMS server. */
function fakeServer(...responses: (Response | Error | ((call: Call) => Response))[]) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const raw = String(init.body)
    const expected = createHmac('sha256', SECRET).update(`${headers['X-Timestamp']}.${raw}`).digest('hex')
    expect(headers['X-Signature']).toBe(expected)
    const call = { url, init, body: JSON.parse(raw) }
    calls.push(call)
    const next = responses.length > 1 ? responses.shift()! : responses[0]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(call) : next.clone()
  })
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const created = () => json(201, { log_id: 7, ingested_at: '2026-01-01T00:00:00.000Z' })

function client(fetch: ReturnType<typeof fakeServer>['fetch'], extra = {}) {
  return new LMSClient({
    baseUrl: `${BASE}/`,
    secret: SECRET,
    sourceService: 'billing',
    environment: 'production',
    backoff: 1,
    fetch,
    ...extra,
  })
}

afterEach(() => vi.useRealTimers())

describe('signing', () => {
  it('matches the shared known-answer vector', () => {
    expect(generateSignature('s', '{"a":1}', '1700000000')).toBe(
      'ab7bd212df57f3ef4ea3c17d4a1a71d8981ef595d4cd699b62517c68d89192a2',
    )
  })
})

describe('direct mode', () => {
  it('applies client defaults and signs the request', async () => {
    const { fetch, calls } = fakeServer(created())
    const result = await client(fetch).info('Payment captured', { order: 42 }, { traceId: 't-1' })
    expect(result?.log_id).toBe(7)
    expect(calls[0].url).toBe(`${BASE}/api/v1/logs/app`)
    expect(calls[0].body).toMatchObject({
      source_service: 'billing',
      environment: 'production',
      level: 'INFO',
      message: 'Payment captured',
      trace_id: 't-1',
      context_json: { order: 42 },
    })
    expect(String(calls[0].body.created_at)).toMatch(/Z$/)
    expect((calls[0].init.headers as Record<string, string>)['User-Agent']).toBe(`lms-logger-js/${VERSION}`)
  })

  it('supports the v0 API (snake_case request objects)', async () => {
    const { fetch, calls } = fakeServer(created())
    await client(fetch).logApp(new AppLogRequest({ level: LogLevel.WARNING, message: 'm', source_service: 'other' }))
    expect(calls[0].body).toMatchObject({ level: 'WARN', source_service: 'other' })
  })

  it('normalises audit fields', async () => {
    const { fetch, calls } = fakeServer(created())
    await client(fetch).audit({
      actorId: 'u-1',
      actorType: 'user',
      action: 'record_delete',
      targetResource: '/r/1',
      outcome: 'success',
      ipAddress: '::1',
      detail: { k: 1 },
    })
    expect(calls[0].url).toMatch(/\/logs\/audit$/)
    expect(calls[0].body).toMatchObject({ actor_type: 'USER', action: 'RECORD_DELETE', outcome: 'SUCCESS', detail_json: { k: 1 } })
  })

  it('validates locally like the server', () => {
    expect(() => new AppLogRequest({ level: 'INFO', message: '  ' })).toThrow(LMSConfigError)
    expect(() => new AppLogRequest({ level: 'LOUD' as never, message: 'x' })).toThrow(/level/)
    const audit = { actor_id: 'u', actor_type: 'USER', target_resource: '/', outcome: 'SUCCESS' } as const
    expect(() => new AuditLogRequest({ ...audit, action: 'user login' })).toThrow(/VERB_NOUN/)
    expect(() => new AuditLogRequest({ ...audit, action: 'X', ip_address: '999.1.1.1' })).toThrow(/ip_address/)
  })

  it('requires source_service', async () => {
    const lms = new LMSClient({ baseUrl: BASE, secret: SECRET, environment: 'p', fetch: fakeServer(created()).fetch })
    await expect(lms.info('x')).rejects.toThrow(LMSConfigError)
  })

  it.each([
    [401, 'SIGNATURE_INVALID', LMSAuthError],
    [403, 'SERVICE_DISABLED', LMSPermissionError],
    [422, 'SERVICE_NOT_REGISTERED', LMSValidationError],
  ])('does not retry %i', async (status, code, Cls) => {
    const { fetch } = fakeServer(json(status, { error_code: code, message: 'no', request_id: 'r1' }))
    const err = await client(fetch).info('x').catch((e) => e)
    expect(err).toBeInstanceOf(Cls)
    expect(err.errorCode).toBe(code)
    expect(err.requestId).toBe('r1')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries 5xx with a fresh timestamp each attempt', async () => {
    const { fetch, calls } = fakeServer(json(503, {}), json(502, {}), created())
    expect((await client(fetch).error('boom'))?.log_id).toBe(7)
    const stamps = calls.map((c) => (c.init.headers as Record<string, string>)['X-Timestamp'])
    expect(new Set(stamps).size).toBe(3)
  })

  it('raises the last error after retries', async () => {
    const { fetch } = fakeServer(json(500, { message: 'down' }))
    await expect(client(fetch, { maxRetries: 2 }).info('x')).rejects.toThrow(LMSServerError)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('honours Retry-After on 429', async () => {
    const { fetch } = fakeServer(json(429, { message: 'slow' }, { 'Retry-After': '0' }), created())
    expect((await client(fetch).info('x'))?.log_id).toBe(7)
    const { fetch: f2 } = fakeServer(json(429, {}, { 'Retry-After': '3' }))
    const err = await client(f2, { maxRetries: 0 }).info('x').catch((e) => e)
    expect(err).toBeInstanceOf(LMSRateLimitError)
    expect(err.retryAfter).toBe(3)
  })

  it('wraps network failures', async () => {
    const { fetch } = fakeServer(new TypeError('fetch failed'))
    const err = await client(fetch, { maxRetries: 1 }).info('x').catch((e) => e)
    expect(err).toBeInstanceOf(LMSConnectionError)
    expect(err.cause).toBeInstanceOf(TypeError)
  })

  it('sends batches', async () => {
    const { fetch, calls } = fakeServer(json(207, { results: [], total: 2, succeeded: 2, failed: 0 }))
    await client(fetch).logAppBatch([{ level: 'INFO', message: 'a' }, { level: 'DEBUG', message: 'b' }])
    expect((calls[0].body.logs as unknown[]).length).toBe(2)
  })
})

describe('buffered mode', () => {
  /** Accepts both ingest endpoints: buffered mode sends a lone entry to /logs/app. */
  function countingServer() {
    const sent: { path: string; count: number }[] = []
    const server = fakeServer((call) => {
      const logs = call.body.logs as unknown[] | undefined
      const count = logs ? logs.length : 1
      sent.push({ path: new URL(call.url).pathname, count })
      if (!logs) return created()
      return json(207, {
        results: logs.map((_, i) => ({ index: i, success: true, log_id: i })),
        total: count,
        succeeded: count,
        failed: 0,
      })
    })
    return { ...server, sent }
  }

  it('batches in the background and flushes', async () => {
    const { fetch, sent } = countingServer()
    const errors: Error[] = []
    const lms = client(fetch, { buffered: true, batchSize: 10, flushInterval: 20, onError: (e: Error) => errors.push(e) })
    for (let i = 0; i < 25; i++) expect(await lms.info(`m${i}`)).toBeUndefined()
    await lms.close()
    expect(errors).toEqual([])
    expect(sent.reduce((a, b) => a + b.count, 0)).toBe(25)
    expect(Math.max(...sent.map((s) => s.count))).toBeLessThanOrEqual(10)
  })

  it('sends a lone queued entry to the single-entry endpoint', async () => {
    const { fetch, sent } = countingServer()
    const errors: Error[] = []
    const lms = client(fetch, { buffered: true, onError: (e: Error) => errors.push(e) })
    await lms.info('only')
    await lms.close()
    expect(errors).toEqual([])
    expect(sent).toEqual([{ path: '/api/v1/logs/app', count: 1 }])
  })

  it('never rejects; failures go to onError', async () => {
    const errors: Error[] = []
    const { fetch } = fakeServer(json(403, { error_code: 'SERVICE_DISABLED' }))
    const lms = client(fetch, { buffered: true, flushInterval: 5, onError: (e: Error) => errors.push(e) })
    await lms.info('dropped')
    await lms.info('   ') // invalid: reported, not thrown
    await lms.close()
    expect(errors.map((e) => e.constructor.name).sort()).toEqual(['LMSConfigError', 'LMSPermissionError'])
  })

  it('reports per-entry batch failures', async () => {
    const errors: Error[] = []
    const { fetch } = fakeServer(
      json(207, {
        results: [
          { index: 0, success: true, log_id: 1 },
          { index: 1, success: false, error_code: 'VALIDATION_ERROR', message: 'bad' },
        ],
        total: 2,
        succeeded: 1,
        failed: 1,
      }),
    )
    const lms = client(fetch, { buffered: true, onError: (e: Error) => errors.push(e) })
    await lms.info('a')
    await lms.info('b')
    await lms.flush()
    expect((errors[0] as unknown as { errorCode: string }).errorCode).toBe('VALIDATION_ERROR')
  })

  it('drops when the queue is full', async () => {
    const errors: Error[] = []
    const lms = client(fakeServer(created()).fetch, {
      buffered: true,
      maxQueue: 1,
      batchSize: 5,
      onError: (e: Error) => errors.push(e),
    })
    await lms.info('1')
    await lms.info('2')
    expect(lms.dropped).toBe(1)
    await lms.close()
  })
})

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(VERSION).toBe(pkg.version)
})
