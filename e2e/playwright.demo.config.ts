// Records docs/demo.gif: `pnpm --filter @codesync/e2e demo`. Same servers as the E2E tests.
import base from "./playwright.config";

export default { ...base, testDir: "./demo", timeout: 240_000, retries: 0 };
