// Runs the built production image (COLLAB_IMAGE) and stops it the way a deploy does. Starting the
// server through a wrapper that swallows SIGTERM loses the last edits, and only a real container
// stop can catch that.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRoomFixture, hasDatabase } from "../db-fixtures";
import { connectClient, SECRET, type TestClient } from "../helpers";

const IMAGE = process.env.COLLAB_IMAGE;
const PORT = 18234;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

function startContainer(): string {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  databaseUrl.hostname = "host.docker.internal";
  return docker(
    "run",
    "--detach",
    "--add-host=host.docker.internal:host-gateway",
    `--publish=127.0.0.1:${PORT}:1234`,
    `--env=DATABASE_URL=${databaseUrl.href}`,
    `--env=WS_TOKEN_SECRET=${SECRET}`,
    IMAGE ?? "",
  );
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return;
    if (Date.now() > deadline) throw new Error("container never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!IMAGE || !hasDatabase)("collab production image", () => {
  let fixture: Awaited<ReturnType<typeof createRoomFixture>>;
  const containers: string[] = [];
  const clients: TestClient[] = [];

  async function start() {
    const id = startContainer();
    containers.push(id);
    await waitForHealth();
    const client = await connectClient(
      `ws://127.0.0.1:${PORT}`,
      fixture.roomId,
      fixture.userId,
      "Tester",
    );
    clients.push(client);
    return { id, client };
  }

  beforeAll(async () => {
    fixture = await createRoomFixture();
  });

  afterAll(async () => {
    for (const c of clients) c.provider.destroy();
    for (const id of containers) docker("rm", "--force", id);
    await fixture.cleanup();
  });

  test("docker stop inside the 500 ms write window saves the edit and exits cleanly", async () => {
    const first = await start();
    first.client.text.insert(0, "typed just before a deploy");
    await new Promise((resolve) => setTimeout(resolve, 100));
    docker("stop", "--time=20", first.id);
    first.client.provider.destroy();
    expect(docker("inspect", "--format={{.State.ExitCode}}", first.id)).toBe("0");

    const second = await start();
    expect(second.client.text.toString()).toBe("typed just before a deploy");
  }, 90_000);
});
