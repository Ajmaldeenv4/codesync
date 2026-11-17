import { describe, expect, test } from "vitest";
import { signRequest, verifyRequest } from "../src/hmac";

const KEY = "internal-test-key-that-is-long-enough-1234";
const NOW = Date.UTC(2026, 0, 1);

describe("signed requests", () => {
  test("a signature verifies for the same body", () => {
    const header = signRequest('{"version":3}', KEY, NOW);
    expect(verifyRequest('{"version":3}', header, KEY, NOW + 5_000)).toEqual({ ok: true });
  });

  test("a changed body is rejected", () => {
    const header = signRequest('{"version":3}', KEY, NOW);
    expect(verifyRequest('{"version":4}', header, KEY, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("a different key is rejected", () => {
    const header = signRequest("body", KEY, NOW);
    expect(verifyRequest("body", header, "another-key-that-is-also-long-enough-xx", NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("old or future timestamps are rejected (replay window is 60 s)", () => {
    const header = signRequest("body", KEY, NOW);
    expect(verifyRequest("body", header, KEY, NOW + 61_000).ok).toBe(false);
    expect(verifyRequest("body", header, KEY, NOW - 61_000).ok).toBe(false);
  });

  test("missing and malformed headers are rejected", () => {
    expect(verifyRequest("body", null, KEY, NOW)).toEqual({ ok: false, reason: "missing" });
    for (const header of ["garbage", "t=1,v1=zz", `t=${NOW},v1=${"a".repeat(63)}`]) {
      expect(verifyRequest("body", header, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  test("short keys are refused", () => {
    expect(() => signRequest("body", "short", NOW)).toThrow(/at least 32/);
  });
});
