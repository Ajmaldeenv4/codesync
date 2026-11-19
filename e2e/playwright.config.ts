import { defineConfig, devices } from "@playwright/test";

const CI = Boolean(process.env.CI);

// Start the apps the test needs. Locally, already-running dev servers are reused.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
// The test-only sign-in provider (ignored by production builds).
env.AUTH_TEST_MODE = "1";

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @codesync/collab start",
      url: "http://localhost:1234/health",
      cwd: "..",
      env,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @codesync/runner start",
      url: "http://localhost:4000/health",
      cwd: "..",
      env,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @codesync/web dev",
      url: "http://localhost:3000/api/health",
      cwd: "..",
      env,
      reuseExistingServer: !CI,
      timeout: 180_000,
    },
  ],
});
