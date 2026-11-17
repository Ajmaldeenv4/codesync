import { loadEnvFileIfExists } from "@codesync/shared/node";
import { createCollabServer } from "./server";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

const tokenSecret = process.env.WS_TOKEN_SECRET;
if (!tokenSecret) {
  console.error("WS_TOKEN_SECRET is not set; refusing to start without room token checks.");
  process.exit(1);
}

const port = Number(process.env.COLLAB_PORT ?? 1234);
const collab = createCollabServer({ tokenSecret });

collab.server.listen(port, () => {
  console.log(`collab listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    collab.close().finally(() => process.exit(0));
  });
}
