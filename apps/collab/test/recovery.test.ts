// Phase 3 "done when": kill the collab server, restart it, and find the document intact.
// Runs the real server process (src/index.ts) against Postgres.
import { getPrisma } from "@codesync/db";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createRoomFixture, hasDatabase } from "./db-fixtures";
import { connectClient, SECRET, waitFor, type TestClient } from "./helpers";

const COLLAB_DIR = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();
const clients: TestClient[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Starts `node --import tsx src/index.ts` and resolves once it is listening. */
function startCollab(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: COLLAB_DIR,
    env: {
      ...process.env,
      COLLAB_PORT: String(port),
      WS_TOKEN_SECRET: SECRET,
      COLLAB_INTERNAL_SECRET: "recovery-test-internal-secret-long-enough",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("collab listening")) resolve(child);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`collab exited early (${code}): ${output}`)));
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe.skipIf(!hasDatabase)("crash recovery (real server process + Postgres)", () => {
  let fixture: Awaited<ReturnType<typeof createRoomFixture>>;

  beforeAll(async () => {
    fixture = await createRoomFixture();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.provider.destroy();
    for (const child of children) child.kill("SIGKILL");
  });

  afterAll(() => fixture.cleanup());

  test("SIGKILL after edits are written: the restarted server serves the same document", async () => {
    const port = await freePort();
    const wsUrl = `ws://127.0.0.1:${port}`;
    const code = "def greet(name):\n    return f'hello {name}'\n";

    let server = await startCollab(port);
    const writer = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Writer");
    clients.push(writer);
    writer.text.insert(0, code);

    // Wait until the batched update is in Postgres (the 500 ms window), then crash hard.
    const db = getPrisma();
    const deadline = Date.now() + 5000;
    while ((await db.docUpdate.count({ where: { roomId: fixture.roomId } })) === 0) {
      if (Date.now() > deadline) throw new Error("update never reached Postgres");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    server.kill("SIGKILL");
    await exited(server);
    writer.provider.destroy();

    const restartedAt = Date.now();
    server = await startCollab(port);
    const reader = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Reader");
    clients.push(reader);
    const recoveryMs = Date.now() - restartedAt;

    expect(reader.text.toString()).toBe(code);
    console.log(`recovery: restart to first synced doc in ${recoveryMs} ms`);
  }, 30_000);

  test("SIGKILL before an edit is written: a client that stays open sends it again", async () => {
    const port = await freePort();
    const wsUrl = `ws://127.0.0.1:${port}`;
    const server = await startCollab(port);
    const writer = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Writer");
    clients.push(writer);
    const rows = () => getPrisma().docUpdate.count({ where: { roomId: fixture.roomId } });
    const rowsBefore = await rows();

    writer.text.insert(0, "# not saved yet\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.kill("SIGKILL");
    await exited(server);
    expect(await rows()).toBe(rowsBefore);

    await startCollab(port);
    const reader = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Reader");
    clients.push(reader);
    await waitFor(
      () => reader.text.toString().startsWith("# not saved yet\n"),
      "the open client to reconnect and resend",
      15_000,
    );
  }, 40_000);

  // Windows has no catchable SIGTERM (child.kill terminates immediately), so this runs on
  // Linux/macOS, including CI.
  test.skipIf(process.platform === "win32")(
    "SIGTERM inside the batch window: shutdown flushes and snapshots before exiting",
    async () => {
      const port = await freePort();
      const wsUrl = `ws://127.0.0.1:${port}`;
      let server = await startCollab(port);
      const writer = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Writer");
      clients.push(writer);

      writer.text.delete(0, writer.text.length);
      writer.text.insert(0, "saved on shutdown");
      // Give the server a moment to receive the update, but stay inside the 500 ms window.
      await new Promise((resolve) => setTimeout(resolve, 100));
      server.kill("SIGTERM");
      expect(await exited(server)).toBe(0);
      writer.provider.destroy();

      server = await startCollab(port);
      const reader = await connectClient(wsUrl, fixture.roomId, fixture.userId, "Reader");
      clients.push(reader);
      expect(reader.text.toString()).toBe("saved on shutdown");
    },
    30_000,
  );
});
