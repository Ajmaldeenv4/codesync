import { updateInitialEnv } from "@next/env";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// One .env at the repo root serves every app; Next only reads apps/web/.env*. Calling
// loadEnvConfig() again is a no-op (it caches its first load), so parse the root file here and
// register it as part of the initial env, which Next restores whenever it reloads env files.
// Variables already set (CI, Vercel) always win.
const rootEnvFile = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnvFile)) {
  const parsed = parseEnv(readFileSync(rootEnvFile, "utf8"));
  const missing = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => process.env[key] === undefined),
  );
  Object.assign(process.env, missing);
  updateInitialEnv(missing);
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
