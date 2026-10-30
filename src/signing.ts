import { createHmac } from 'node:crypto'

/**
 * HMAC-SHA256 over `${timestamp}.` + raw body bytes, hex encoded.
 * Must match the server's `verify_service_signature`.
 */
export function generateSignature(secret: string, body: string | Uint8Array, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')
}

/** Unix epoch seconds as a string. */
export function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000))
}
