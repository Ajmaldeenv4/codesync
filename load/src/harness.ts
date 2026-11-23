// Starts the real services as child processes and connects real y-websocket clients to them.
import { getPrisma } from "@codesync/db";
import { signRoomToken } from "@codesync/shared/token";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

// Every y-websocket provider adds an exit listener; hundreds of them are expected here.
process.setMaxListeners(0);

const ROOT = new URL("../../", import.meta.url);
export const TOKEN_SECRET = randomBytes(32).toString("base64");
export const RUNNER_KEY = randomBytes(32).toString("base64");

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(check: () => boolean, what: string, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface Service {
  child: ChildProcess;
  kill(): Promise<void>;
}

/** Runs apps/<name>/src/index.ts and resolves when its output contains `readyText`. */
export function startService(
  name: "collab" | "runner",
  env: Record<string, string>,
  readyText: string,
): Promise<Service> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(`apps/${name}`, ROOT)),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const kill = async () => {
    child.kill("SIGKILL");
    await exited;
  };
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(readyText)) resolve({ child, kill });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${name} exited (${code}): ${output}`)));
  });
}

export const startCollab = (port: number) =>
  startService(
    "collab",
    { COLLAB_PORT: String(port), WS_TOKEN_SECRET: TOKEN_SECRET },
    "collab listening",
  );

export async function createRoom() {
  const db = getPrisma();
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const user = await db.user.create({
    data: { name: "Load test", email: `load-${tag}@load.codesync.invalid` },
  });
  await db.room.create({
    data: { id: `ld${tag}`, name: "load", language: "python", ownerId: user.id },
  });
  return {
    roomId: `ld${tag}`,
    userId: user.id,
    cleanup: async () => {
      await db.user.delete({ where: { id: user.id } });
    },
  };
}

export interface Client {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  /** Times the connection dropped after first connecting. */
  disconnects: number;
}

export async function connect(port: number, roomId: string, userId: string): Promise<Client> {
  const doc = new Y.Doc();
  const token = await signRoomToken(
    { sub: userId, roomId, name: "Load", avatar: null },
    TOKEN_SECRET,
  );
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, roomId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  const client: Client = { doc, text: doc.getText("monaco"), provider, disconnects: 0 };
  provider.on("connection-close", () => {
    client.disconnects += 1;
  });
  await waitFor(() => provider.synced, "client to sync");
  return client;
}

export function disconnect(client: Client) {
  client.provider.destroy();
  client.doc.destroy();
}
