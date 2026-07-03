import { jest } from "@jest/globals";
import { createHmac } from "crypto";
import { generateSignature, currentTimestamp } from "../src/signing.js";
import { LMSClient } from "../src/client.js";
import { AppLogRequest, AuditLogRequest, LogLevel, ActorType } from "../src/models.js";
import { LMSAuthError, LMSRateLimitError, LMSValidationError } from "../src/exceptions.js";

const BASE = "https://lms.test";
const SECRET = "test-secret";
const SVC = "abc123";

// ── signing ───────────────────────────────────────────────────────────────────

test("signature is deterministic", () => {
  const body = Buffer.from('{"foo":"bar"}');
  const ts = "1700000000";
  expect(generateSignature(SECRET, body, ts)).toBe(generateSignature(SECRET, body, ts));
});

test("signature changes with body", () => {
  const ts = "1700000000";
  expect(generateSignature(SECRET, Buffer.from("aaa"), ts)).not.toBe(
    generateSignature(SECRET, Buffer.from("bbb"), ts),
  );
});

test("signature changes with timestamp", () => {
  const body = Buffer.from("aaa");
  expect(generateSignature(SECRET, body, "1000")).not.toBe(
    generateSignature(SECRET, body, "2000"),
  );
});

test("signature matches manual HMAC", () => {
  const body = Buffer.from('{"x":1}');
  const ts = "1700000000";
  const message = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), body]);
  const expected = createHmac("sha256", SECRET).update(message).digest("hex");
  expect(generateSignature(SECRET, body, ts)).toBe(expected);
});

test("currentTimestamp returns unix seconds string", () => {
  const ts = currentTimestamp();
  expect(typeof ts).toBe("string");
  expect(Number(ts)).toBeCloseTo(Date.now() / 1000, -1);
});

// ── AppLogRequest validation ──────────────────────────────────────────────────

test("AppLogRequest accepts valid data", () => {
  const req = new AppLogRequest({
    source_service: "my-svc",
    environment: "production",
    level: LogLevel.INFO,
    message: "hello",
    trace_id: "trace-abc",
  });
  expect(req.level).toBe("INFO");
  expect(req.context_json).toBeNull();
  expect(typeof req.created_at).toBe("string");
});

test("AppLogRequest rejects invalid level", () => {
  expect(() =>
    new AppLogRequest({
      source_service: "svc",
      environment: "prod",
      level: "VERBOSE", // not in LogLevel
      message: "x",
      trace_id: "t",
    }),
  ).toThrow(TypeError);
});

test("AppLogRequest requires source_service", () => {
  expect(() =>
    new AppLogRequest({
      source_service: "",
      environment: "prod",
      level: LogLevel.INFO,
      message: "x",
      trace_id: "t",
    }),
  ).toThrow(TypeError);
});

// ── AuditLogRequest validation ────────────────────────────────────────────────

test("AuditLogRequest accepts valid data", () => {
  const req = new AuditLogRequest({
    source_service: "my-svc",
    environment: "production",
    action: "DELETE",
    actor_type: ActorType.USER,
    target_resource: "citizen_record:42",
    outcome: "success",
    ip_address: "127.0.0.1",
  });
  expect(req.actor_id).toBeNull();
  expect(req.detail_json).toBeNull();
});

test("AuditLogRequest rejects invalid actor_type", () => {
  expect(() =>
    new AuditLogRequest({
      source_service: "svc",
      environment: "prod",
      action: "READ",
      actor_type: "ROBOT",
      target_resource: "res",
      outcome: "success",
      ip_address: "0.0.0.0",
    }),
  ).toThrow(TypeError);
});

// ── LMSClient HTTP behavior ───────────────────────────────────────────────────

function makeRequest(data) {
  return new AppLogRequest({
    source_service: SVC,
    environment: "test",
    level: LogLevel.INFO,
    message: "test",
    trace_id: "trace-1",
    ...data,
  });
}

function mockFetch(status, body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

test("logApp success returns response", async () => {
  mockFetch(201, { log_id: 1, ingested_at: "2024-01-01T00:00:00Z" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  const resp = await client.logApp(makeRequest());
  expect(resp.log_id).toBe(1);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("logApp sends correct headers", async () => {
  mockFetch(201, { log_id: 1, ingested_at: "2024-01-01T00:00:00Z" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  await client.logApp(makeRequest());
  const [, options] = global.fetch.mock.calls[0];
  expect(options.headers["x-timestamp"]).toBeTruthy();
  expect(options.headers["x-signature"]).toMatch(/^[0-9a-f]{64}$/);
  expect(options.headers["Content-Type"]).toBe("application/json");
});

test("401 raises LMSAuthError", async () => {
  mockFetch(401, { detail: "invalid signature" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  await expect(client.logApp(makeRequest())).rejects.toThrow(LMSAuthError);
});

test("422 raises LMSValidationError", async () => {
  mockFetch(422, { detail: "field required" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  await expect(client.logApp(makeRequest())).rejects.toThrow(LMSValidationError);
});

test("429 raises LMSRateLimitError and is NOT retried", async () => {
  mockFetch(429, { detail: "slow down" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET, maxRetries: 3 });
  await expect(client.logApp(makeRequest())).rejects.toThrow(LMSRateLimitError);
  expect(global.fetch).toHaveBeenCalledTimes(1); // never retried
});

test("network error retries up to maxRetries", async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET, maxRetries: 3 });
  await expect(client.logApp(makeRequest())).rejects.toThrow("LMS unreachable");
  expect(global.fetch).toHaveBeenCalledTimes(3);
});

test("logAppBatch sends logs array", async () => {
  mockFetch(200, { results: [], total: 2, succeeded: 2, failed: 0 });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  const resp = await client.logAppBatch([makeRequest(), makeRequest({ message: "second" })]);
  expect(resp.total).toBe(2);
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.logs).toHaveLength(2);
});

test("logAudit sends to audit endpoint", async () => {
  mockFetch(201, { log_id: 99, ingested_at: "2024-01-01T12:00:00Z" });
  const client = new LMSClient({ baseUrl: BASE, serviceId: SVC, secret: SECRET });
  const resp = await client.logAudit(
    new AuditLogRequest({
      source_service: SVC,
      environment: "production",
      action: "DELETE",
      actor_type: ActorType.USER,
      target_resource: "user:42",
      outcome: "success",
      ip_address: "10.0.0.1",
      actor_id: "user-uuid",
    }),
  );
  expect(resp.log_id).toBe(99);
  const [url] = global.fetch.mock.calls[0];
  expect(url).toContain("/api/v1/logs/audit");
});
