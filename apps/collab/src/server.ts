import { roomIdSchema } from "@codesync/shared";
import { verifyRoomToken } from "@codesync/shared/token";
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RateCounter, type CollabMetrics } from "./metrics";
import { RoomManager } from "./room";

export interface CollabServerOptions {
  /** Shared with the web app, which signs the room tokens. */
  tokenSecret: string;
  /** How often to ping clients; a client that misses one pong is dropped. */
  pingIntervalMs?: number;
  /** Largest accepted WebSocket message, in bytes. */
  maxPayloadBytes?: number;
}

export interface CollabServer {
  server: Server;
  rooms: RoomManager;
  metrics(): CollabMetrics;
  close(): Promise<void>;
}

export function createCollabServer(options: CollabServerOptions): CollabServer {
  const { tokenSecret, pingIntervalMs = 30_000, maxPayloadBytes = 5 * 1024 * 1024 } = options;
  const startedAt = Date.now();
  const updateRate = new RateCounter();
  const rooms = new RoomManager({ onDocUpdate: () => updateRate.record() });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  const metrics = (): CollabMetrics => ({
    connectedClients: wss.clients.size,
    activeRooms: rooms.size,
    updatesPerSecond: updateRate.perSecond(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "collab" }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(metrics()));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error("upgrade failed", err);
      reject(socket, 500);
    });
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // y-websocket connects to `${serverUrl}/${roomId}?token=...`.
    const url = new URL(req.url ?? "/", "http://collab.invalid");
    const roomId = decodeURIComponent(url.pathname.slice(1));
    const token = url.searchParams.get("token");
    if (!roomIdSchema.safeParse(roomId).success) return reject(socket, 404);
    if (!token) return reject(socket, 401);

    const verified = await verifyRoomToken(token, tokenSecret, roomId);
    if (!verified.ok) return reject(socket, verified.reason === "wrong_room" ? 403 : 401);

    const room = await rooms.open(roomId);
    if (socket.destroyed) {
      rooms.releaseIfEmpty(roomId);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return ws.close(1003, "binary messages only");
        try {
          room.handleMessage(ws, toUint8Array(data));
        } catch (err) {
          console.warn(`room ${roomId}: dropping client after bad message`, err);
          ws.close(1007, "bad message");
        }
      });
      ws.on("close", () => {
        room.removeConnection(ws);
        rooms.releaseIfEmpty(roomId);
      });
      ws.on("error", () => ws.terminate());
      room.addConnection(ws, verified.claims);
    });
  }

  // Heartbeat: drop connections that stop answering pings (dead networks, sleeping laptops).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingIntervalMs);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    rooms.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, rejectClose) =>
      server.close((err) => (err ? rejectClose(err) : resolve())),
    );
  }

  return { server, rooms, metrics, close };
}

function reject(socket: Duplex, status: number) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
}
