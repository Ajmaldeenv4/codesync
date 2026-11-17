import { signRoomToken, type RoomTokenClaims } from "@codesync/shared/token";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { createCollabServer, type CollabServer } from "../src/server";

export const SECRET = "collab-test-secret-that-is-long-enough-123";

export interface RunningServer {
  collab: CollabServer;
  httpUrl: string;
  wsUrl: string;
}

export async function startServer(): Promise<RunningServer> {
  const collab = createCollabServer({ tokenSecret: SECRET, pingIntervalMs: 60_000 });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  const { port } = collab.server.address() as AddressInfo;
  return { collab, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
}

export function tokenFor(roomId: string, sub = "user_a", name = "Ada", ttlSeconds?: number) {
  const claims: RoomTokenClaims = { sub, roomId, name, avatar: null };
  return signRoomToken(claims, SECRET, ttlSeconds);
}

export interface TestClient {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
}

/** A real y-websocket client, the same provider the browser uses. */
export async function connectClient(wsUrl: string, roomId: string, sub: string, name: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(wsUrl, roomId, doc, {
    params: { token: await tokenFor(roomId, sub, name) },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  const client: TestClient = { doc, text: doc.getText("monaco"), provider };
  await waitFor(() => provider.synced, `${name} to sync`);
  return client;
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Opens a raw socket and resolves with the HTTP status of the rejected upgrade (or 101). */
export function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", (err) => {
      if (ws.readyState === WebSocket.CLOSED) return;
      reject(err);
    });
  });
}
