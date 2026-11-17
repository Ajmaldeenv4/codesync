// Test-only sign-in. Playwright can't drive a real GitHub login, so when AUTH_TEST_MODE=1 in a
// non-production build, a Credentials provider signs in a local user by name.

export function isTestAuthEnabled(env: {
  AUTH_TEST_MODE?: string | undefined;
  NODE_ENV?: string | undefined;
}): boolean {
  return env.AUTH_TEST_MODE === "1" && env.NODE_ENV !== "production";
}

/** Normalises a display name for a test user: trimmed, collapsed whitespace, max 40 chars. */
export function normaliseTestUserName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  return name.length > 0 ? name : null;
}

/** Stable synthetic email per test name, on a reserved domain that can never receive mail. */
export function testUserEmail(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "user"}@test.codesync.invalid`;
}
