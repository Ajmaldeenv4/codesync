import { describe, expect, test, vi } from "vitest";

// lib/session imports the Auth.js instance; stub it so these pure helpers test in isolation.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { safeCallbackPath } = await import("./session");
const { isTestAuthEnabled, normaliseTestUserName, testUserEmail } = await import("./test-auth");

describe("isTestAuthEnabled", () => {
  test("is on only when AUTH_TEST_MODE=1 outside production", () => {
    expect(isTestAuthEnabled({ AUTH_TEST_MODE: "1", NODE_ENV: "development" })).toBe(true);
    expect(isTestAuthEnabled({ AUTH_TEST_MODE: "1", NODE_ENV: "test" })).toBe(true);
  });

  test("is always off in production, even when the flag is set", () => {
    expect(isTestAuthEnabled({ AUTH_TEST_MODE: "1", NODE_ENV: "production" })).toBe(false);
  });

  test("is off when the flag is missing or not exactly 1", () => {
    expect(isTestAuthEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isTestAuthEnabled({ AUTH_TEST_MODE: "0", NODE_ENV: "development" })).toBe(false);
    expect(isTestAuthEnabled({ AUTH_TEST_MODE: "true", NODE_ENV: "development" })).toBe(false);
  });
});

describe("test user helpers", () => {
  test("names are trimmed, collapsed and capped", () => {
    expect(normaliseTestUserName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(normaliseTestUserName("x".repeat(60))).toHaveLength(40);
    expect(normaliseTestUserName("   ")).toBeNull();
    expect(normaliseTestUserName(42)).toBeNull();
  });

  test("emails are stable slugs on a reserved domain", () => {
    expect(testUserEmail("Ada Lovelace")).toBe("ada-lovelace@test.codesync.invalid");
    expect(testUserEmail("!!!")).toBe("user@test.codesync.invalid");
  });
});

describe("safeCallbackPath", () => {
  test("keeps same-origin relative paths", () => {
    expect(safeCallbackPath("/room/abc1234567")).toBe("/room/abc1234567");
  });

  test("rejects anything that could leave the origin", () => {
    for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "", null]) {
      expect(safeCallbackPath(value)).toBe("/");
    }
  });
});
