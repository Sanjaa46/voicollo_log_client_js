# lms-logger (Node.js)

Node.js / TypeScript client for the **Voicollo Log Management System**.

- HMAC-SHA256 request signing. Every retry is signed fresh and never counts as a replay.
- Automatic retries with jittered backoff on network errors, 5xx and 429 (`Retry-After`).
- Field validation that matches the server.
- **Buffered mode**: background batching. Logging never throws and never crashes your process.
- ESM and CommonJS, bundled type definitions, zero runtime dependencies.

Requires Node.js ≥ 18.17 and an LMS server ≥ 2.0.

## Install

Pin a release tag (the package builds itself on install):

```bash
npm install github:Sanjaa46/voicollo_log_client_js#v1.0.0
```

`package.json`:

```json
"dependencies": { "lms-logger": "github:Sanjaa46/voicollo_log_client_js#v1.0.0" }
```

## Configure

Register your service in the LMS console (**Services → Register**), then set:

| Variable | Value |
|---|---|
| `LMS_URL` | the LMS address, e.g. `https://lms.example.com` |
| `LMS_INGEST_SECRET` | the LMS `INGEST_SIGNING_SECRET` |
| `LMS_SOURCE_SERVICE` | your registered service id |

## Quick start

```ts
import { LMSClient } from 'lms-logger'          // or: const { LMSClient } = require('lms-logger')

const lms = new LMSClient({
  baseUrl: process.env.LMS_URL!,
  secret: process.env.LMS_INGEST_SECRET!,
  sourceService: process.env.LMS_SOURCE_SERVICE!,
  environment: process.env.NODE_ENV ?? 'production',
  buffered: true,                                 // recommended for servers
  onError: (err) => console.error('[lms]', err.message),
})

lms.info('Payment captured', { orderId: 8812, amount: 129000 })
lms.error('Gateway timeout', { gateway: 'golomt' }, { traceId: req.id })

lms.audit({
  actorId: user.id,
  actorType: 'USER',              // USER | SERVICE | SYSTEM
  action: 'RECORD_DELETE',        // VERB_NOUN
  targetResource: '/records/42',
  outcome: 'SUCCESS',             // SUCCESS | FAILURE | PARTIAL
  ipAddress: req.ip,
  detail: { reason: 'duplicate' },
})

process.on('SIGTERM', async () => {
  await lms.close()               // sends whatever is still queued
  process.exit(0)
})
```

Levels: `debug`, `info`, `warn`, `error`, `fatal`, or
`lms.log('WARNING', ...)`. Timestamps default to now (UTC).

## Buffered vs direct mode

| | `buffered: true` | `buffered: false` (default) |
|---|---|---|
| Call returns | immediately, `undefined` | after the HTTP response, `{ log_id, ingested_at }` |
| Failures | `onError(error, entry)` | the promise rejects with an `LMSError` |
| Transport | app logs batched (`batchSize` 50, `flushInterval` 2000 ms); audit logs sent individually | one request per call |
| Use for | web servers, workers | scripts, tests, "must be stored before continuing" |

Buffered mode keeps at most `maxQueue` (10 000) entries in memory; beyond that,
entries are dropped and reported (`lms.dropped` counts them). The queue is
flushed on `close()`, `flush()` and Node's `beforeExit`.

## Explicit requests and batches (v0 API, still supported)

```ts
import { AppLogRequest, AuditLogRequest, LogLevel } from 'lms-logger'

await lms.logApp(new AppLogRequest({ level: LogLevel.INFO, message: 'hi', context_json: { a: 1 } }))
const result = await lms.logAppBatch([
  { level: 'INFO', message: 'step 1' },
  { level: 'DEBUG', message: 'step 2' },
])
result.results.filter((r) => !r.success)    // partial success is per entry
```

## Errors

Every error extends `LMSError` (`statusCode`, `errorCode`, `requestId`,
`responseBody`).

| Class | When | Retried |
|---|---|---|
| `LMSConfigError` | missing `secret`/`sourceService`/`environment`, invalid field | — |
| `LMSAuthError` | 401: wrong secret, or clock skew (`SIGNATURE_EXPIRED`) | no |
| `LMSPermissionError` | 403 `SERVICE_DISABLED` | no |
| `LMSValidationError` | 422: invalid payload, `SERVICE_NOT_REGISTERED` | no |
| `LMSConflictError` | 409 `DUPLICATE_REQUEST` | no |
| `LMSRateLimitError` | 429 (`retryAfter`) | yes |
| `LMSServerError` | 5xx | yes |
| `LMSConnectionError` | network failure / timeout (`cause` holds the original) | yes |

Options: `timeout` (10 000 ms), `maxRetries` (3), `backoff` (500 ms),
`maxBackoff` (30 000 ms), `headers`, `fetch` (custom implementation).

## Signing protocol

```
X-Timestamp: <unix seconds>
X-Signature: hex(HMAC_SHA256(secret, "<timestamp>." + raw_json_body))
```

`generateSignature(secret, body, timestamp)` is exported if you need to sign
requests yourself.

## Development

```bash
npm install
npm run check      # typecheck, lint, tests, build, ESM+CJS smoke test
```

Release: bump `version` in `package.json` and `src/version.ts` (a test checks
they match), add a CHANGELOG section, open a PR and merge it. On `main`, the
Release workflow sees a version without a tag, runs `npm run check`, and then
creates the `vX.Y.Z` tag and GitHub release with the packed tarball. It also
publishes to npm if an `NPM_TOKEN` secret exists. Nobody pushes tags by hand.
