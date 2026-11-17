import { loadEnvFileIfExists } from "@codesync/shared/node";
import { createCollabServer } from "./server";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

const port = Number(process.env.COLLAB_PORT ?? 1234);
const server = createCollabServer();

server.listen(port, () => {
  console.log(`collab listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
