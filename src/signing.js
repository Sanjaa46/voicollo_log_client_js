// NOTE: The Python implementation does:
//   message = f"{timestamp}.".encode() + body   ← raw bytes concat, NOT sha256(body)
// The docstring says sha256(body) but the code does NOT do that.
// This JS port replicates the ACTUAL implementation, not the docstring.

import { createHmac } from "crypto";

/**
 * HMAC-SHA256 over `${timestamp}.${body_as_utf8}`.
 *
 * Replicates Python: hmac.new(secret.encode(), f"{timestamp}.".encode() + body, sha256).hexdigest()
 *
 * @param {string} secret
 * @param {Buffer|string} body - raw request body bytes
 * @param {string} timestamp - unix epoch seconds as string
 * @returns {string} hex digest
 */
export function generateSignature(secret, body, timestamp) {
  const prefix = Buffer.from(`${timestamp}.`, "utf8");
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const message = Buffer.concat([prefix, bodyBuf]);
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Unix epoch as string (seconds precision).
 * @returns {string}
 */
export function currentTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}
