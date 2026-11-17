// Signed service-to-service requests (web -> collab internal API, web -> runner).
// Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Node-only.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-codesync-signature";
export const MAX_SKEW_SECONDS = 60;
const MIN_KEY_LENGTH = 32;

export type VerifySignatureResult =
  { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

function mac(secret: string, timestamp: number, body: string): Buffer {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`HMAC key must be at least ${MIN_KEY_LENGTH} characters`);
  }
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
}

export function signRequest(body: string, secret: string, now: number = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${mac(secret, timestamp, body).toString("hex")}`;
}

export function verifyRequest(
  body: string,
  header: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): VerifySignatureResult {
  if (!header) return { ok: false, reason: "missing" };
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match?.[1] || !match[2]) return { ok: false, reason: "malformed" };

  const timestamp = Number(match[1]);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale" };
  }
  const expected = mac(secret, timestamp, body);
  const given = Buffer.from(match[2], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
