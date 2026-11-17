import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Local dev keeps DATABASE_URL in the repo-root .env; CI and prod set it directly.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Only migrate/introspect need a URL; `prisma generate` works without one.
  datasource: { url: process.env.DATABASE_URL },
});
