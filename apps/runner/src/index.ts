import { loadEnvFileIfExists } from "@codesync/shared/node";
import Docker from "dockerode";
import { DockerSandbox } from "./sandbox";
import { createRunnerServer } from "./server";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

const hmacKey = process.env.RUNNER_HMAC_KEY;
if (!hmacKey) {
  console.error("RUNNER_HMAC_KEY is not set; refusing to start an unauthenticated runner.");
  process.exit(1);
}

const port = Number(process.env.RUNNER_PORT ?? 4000);
// DOCKER_HOST is honoured if set; otherwise the local socket (or named pipe on Windows).
const sandbox = new DockerSandbox(new Docker());
const server = createRunnerServer({
  hmacKey,
  sandbox,
  maxConcurrentRuns: Number(process.env.RUNNER_MAX_CONCURRENCY ?? 4),
});

server.listen(port, () => {
  console.log(`runner listening on :${port}`);
});

// Pull images in the background; /health reports ready=true once done and /run returns 503
// until then.
sandbox.prepare().catch((err: unknown) => {
  console.error("failed to prepare sandbox images", err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
