# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [SemVer](https://semver.org/). Releases are git tags `vX.Y.Z`
matching `package.json`.

## [Unreleased]

## [1.0.0] - 2026-10-30

Requires LMS server **2.0.0** or newer for the documented error codes.

### Breaking
- Rewritten in TypeScript and shipped as a dual ESM/CommonJS build in `dist/`
  (built automatically on `npm install` from git via the `prepare` script).
- `maxRetries` counts *retries* (default 3 → up to 4 attempts).
- `AppLogRequest.trace_id` and `AuditLogRequest.ip_address` are optional and
  `actor_id` is required, matching the server.
- Invalid fields throw `LMSConfigError` (was `TypeError`).

### Added
- `sourceService` / `environment` client defaults; per-call overrides.
- `info/debug/warn/error/fatal/log()` and `audit()` (camelCase) helpers.
- Buffered mode (`buffered: true`): background batching, `flush()`, `close()`,
  `onError`, bounded queue, automatic flush on `beforeExit`. Never rejects.
- Error classes for every status (`LMSPermissionError`, `LMSNotFoundError`,
  `LMSConflictError`, `LMSServerError`, `LMSConfigError`, `LMSQueueFullError`)
  with `errorCode` and `requestId`.
- Plain objects accepted wherever request classes are.
- `VERSION` export and `User-Agent: lms-logger-js/<version>`; custom `fetch` option.

### Fixed
- `require('lms-logger')` crashed: `exports.require` pointed at a missing file.
- Retries reused the first signature (rejected after 30 s); each attempt is
  now freshly signed with a strictly increasing timestamp.
- 5xx and 429 were not retried; `Retry-After` is honoured.
- `outcome` was never validated against the allowed values.

## [0.1.0] - 2025-06-11

Initial version.
