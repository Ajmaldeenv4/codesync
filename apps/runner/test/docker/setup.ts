// Shared setup for the real-Docker suites. Locally they skip without a Docker daemon; CI sets
// REQUIRE_DOCKER=1 so a missing daemon fails loudly instead of silently skipping.
import Docker from "dockerode";
import { DockerSandbox } from "../../src/sandbox";

export const docker = new Docker();

export const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);

if (!dockerAvailable && process.env.REQUIRE_DOCKER === "1") {
  throw new Error("REQUIRE_DOCKER=1 but the Docker daemon is not reachable");
}

export const sandbox = new DockerSandbox(docker);

/** Images may need pulling on a fresh machine. */
export const PREPARE_TIMEOUT_MS = 300_000;
/** One run is capped at 5 s, plus container start/teardown. */
export const RUN_TIMEOUT_MS = 30_000;

export async function sandboxContainers(): Promise<number> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: ["codesync.sandbox=1"] },
  });
  return list.length;
}
