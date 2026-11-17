import { loadEnvFileIfExists } from "@codesync/shared/node";
import { createRunnerServer } from "./server";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

const port = Number(process.env.RUNNER_PORT ?? 4000);
const server = createRunnerServer();

server.listen(port, () => {
  console.log(`runner listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
