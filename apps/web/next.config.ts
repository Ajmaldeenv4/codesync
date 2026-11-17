import { loadEnvConfig } from "@next/env";
import path from "node:path";
import type { NextConfig } from "next";

// One .env at the repo root serves every app; Next only looks in apps/web by default.
loadEnvConfig(path.resolve(process.cwd(), "../.."));

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
