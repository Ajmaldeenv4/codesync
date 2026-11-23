import { getPrisma } from "@codesync/db";
import { loadEnvFileIfExists } from "@codesync/shared/node";
import { PrismaStore } from "./prisma-store";
import { createCollabServer } from "./server";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

const tokenSecret = process.env.WS_TOKEN_SECRET;
if (!tokenSecret) {
  console.error("WS_TOKEN_SECRET is not set; refusing to start without room token checks.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set; rooms would not be persisted.");
  process.exit(1);
}
const internalSecret = process.env.COLLAB_INTERNAL_SECRET || undefined;
if (!internalSecret)
  console.warn("COLLAB_INTERNAL_SECRET is not set; history restore is disabled.");

const allowedOrigins = (process.env.COLLAB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
  console.warn("COLLAB_ALLOWED_ORIGINS is not set; accepting WebSockets from any site.");
}

const port = Number(process.env.COLLAB_PORT ?? 1234);
const collab = createCollabServer({
  tokenSecret,
  internalSecret,
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  store: new PrismaStore(getPrisma()),
});

collab.server.listen(port, () => {
  console.log(`collab listening on :${port}`);
});

// Graceful shutdown persists every open room before exiting.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: saving open rooms`);
    collab
      .close()
      .catch((err: unknown) => console.error("shutdown failed", err))
      .finally(() => process.exit(0));
  });
}
