# lms-logger

Node.js client for the LMS Log Management System API.  
Handles HMAC-SHA256 request signing, retries, and response parsing.

## Requirements

Node.js 18+ (uses native `fetch` and `crypto`).

## Installation

```bash
# From GitHub (no npm publish needed)
npm install github:YOUR_ORG/lms-logger-js

# Or pin to a commit
npm install github:YOUR_ORG/lms-logger-js#abc1234
```

---

## Quick Start

```js
import { LMSClient, AppLogRequest, AuditLogRequest, LogLevel, ActorType } from "lms-logger";

const client = new LMSClient({
  baseUrl: "https://lms.example.mn",
  serviceId: "your32charhexserviceid",
  secret: "your-hmac-secret",
});

// Single app log
await client.logApp(new AppLogRequest({
  source_service: "my-service",
  environment: "production",
  level: LogLevel.INFO,
  message: "Service started",
  trace_id: "trace-abc123",
  context_json: { version: "1.0.0" },
}));

// Batch app logs (one HTTP call)
await client.logAppBatch([
  new AppLogRequest({ source_service: "my-service", environment: "production", level: LogLevel.DEBUG, message: "step 1", trace_id: "t1" }),
  new AppLogRequest({ source_service: "my-service", environment: "production", level: LogLevel.DEBUG, message: "step 2", trace_id: "t2" }),
]);

// Audit log (immutable — DELETE is blocked by LMS)
await client.logAudit(new AuditLogRequest({
  source_service: "my-service",
  environment: "production",
  action: "DELETE",
  actor_type: ActorType.USER,
  actor_id: "user-uuid",
  target_resource: "citizen_record:42",
  outcome: "success",
  ip_address: "10.0.0.1",
}));

client.close(); // no-op, kept for API symmetry
```

---

## Error Handling

```js
import {
  LMSAuthError,
  LMSRateLimitError,
  LMSValidationError,
  LMSConnectionError,
} from "lms-logger";

try {
  await client.logApp(...);
} catch (err) {
  if (err instanceof LMSAuthError) {
    // Wrong secret or clock drift — check x-timestamp / x-signature
  } else if (err instanceof LMSRateLimitError) {
    // Back off — never retry immediately
  } else if (err instanceof LMSValidationError) {
    // Payload rejected — err.responseBody has details
    console.error(err.responseBody);
  } else if (err instanceof LMSConnectionError) {
    // LMS unreachable after maxRetries attempts
  }
}
```

---

## HMAC Signing

Every request is signed with:

```
message  = Buffer.concat([Buffer.from(`${unix_timestamp}.`), body_utf8])
signature = HMAC-SHA256(secret, message).hexdigest()

Headers sent:
  x-timestamp: <unix_epoch_seconds>
  x-signature: <hex_digest>
```

This matches the Python `lms-logger` client exactly.

---

## Configuration

| Option | Default | Description |
|---|---|---|
| `baseUrl` | required | LMS API base URL |
| `serviceId` | required | Your registered service UUID (32 hex chars) |
| `secret` | required | HMAC shared secret |
| `timeout` | `10000` | HTTP timeout in milliseconds |
| `maxRetries` | `3` | Retries on network error (never retries 401/422/429) |

---

## Log Levels

```js
LogLevel.DEBUG    // "DEBUG"
LogLevel.INFO     // "INFO"
LogLevel.WARNING  // "WARN"
LogLevel.ERROR    // "ERROR"
LogLevel.FATAL    // "FATAL"
```

## Actor Types (Audit Logs)

```js
ActorType.USER     // "USER"
ActorType.SERVICE  // "SERVICE"
ActorType.SYSTEM   // "SYSTEM"
```

---

## Running Tests

```bash
npm test
```
