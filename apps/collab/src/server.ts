import { roomIdSchema } from "@codesync/shared";
import { textFromState } from "@codesync/shared/doc";
import { SIGNATURE_HEADER, verifyRequest } from "@codesync/shared/hmac";
import { verifyRoomToken } from "@codesync/shared/token";
import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { RateCounter, type CollabMetrics } from "./metrics";
import type { PersistenceOptions } from "./persistence";
import { RoomManager } from "./room";
import { MemoryStore, type DocStore } from "./store";

export interface CollabServerOptions {
  /** Shared with the web app, which signs the room tokens. */
  tokenSecret: string;
  /** Authenticates web -> collab internal calls (history restore). Internal API is off without it. */
  internalSecret?: string;
  /**
   * Web origins allowed to open a WebSocket. Unset allows any (local dev). Browsers always send
   * Origin, so this stops other sites from using a visitor's token; it is not the main check.
   */
  allowedOrigins?: string[];
  /** Where documents are persisted. Defaults to an in-memory store (tests, no database). */
  store?: DocStore;
  persistence?: PersistenceOptions;
  /** How often to ping clients; a client that misses one pong is dropped. */
  pingIntervalMs?: number;
  /** Largest accepted WebSocket message, in bytes. */
  maxPayloadBytes?: number;
}

export interface CollabServer {
  server: Server;
  rooms: RoomManager;
  store: DocStore;
  metrics(): CollabMetrics;
  close(): Promise<void>;
}

const MAX_INTERNAL_BODY_BYTES = 16 * 1024;
const restoreBodySchema = z.object({ version: z.number().int().positive() });

export function createCollabServer(options: CollabServerOptions): CollabServer {
  const {
    tokenSecret,
    internalSecret,
    allowedOrigins,
    store = new MemoryStore(),
    pingIntervalMs = 30_000,
    maxPayloadBytes = 5 * 1024 * 1024,
  } = options;
  const startedAt = Date.now();
  const updateRate = new RateCounter();
  const rooms = new RoomManager(
    store,
    {
      onDocUpdate: () => updateRate.record(),
      onChat: (messages) => {
        store.saveChat(messages).catch((err: unknown) => console.error("chat mirror failed", err));
      },
    },
    options.persistence,
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  const metrics = (): CollabMetrics => ({
    connectedClients: wss.clients.size,
    activeRooms: rooms.size,
    updatesPerSecond: updateRate.perSecond(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });

  const server = createServer((req, res) => {
    handleHttp(req, res).catch((err: unknown) => {
      console.error("request failed", err);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://collab.invalid").pathname;
    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { status: "ok", service: "collab" });
    }
    if (req.method === "GET" && path === "/metrics") {
      return json(res, 200, metrics());
    }
    const restore = /^\/internal\/rooms\/([^/]+)\/restore$/.exec(path);
    if (req.method === "POST" && restore?.[1]) {
      return handleRestore(req, res, decodeURIComponent(restore[1]));
    }
    res.writeHead(404).end();
  }

  /** POST /internal/rooms/:id/restore {version}: signed by the web app after its owner check. */
  async function handleRestore(req: IncomingMessage, res: ServerResponse, roomId: string) {
    if (!internalSecret) return json(res, 503, { error: "internal_api_disabled" });
    const body = await readBody(req, MAX_INTERNAL_BODY_BYTES);
    if (body === null) return json(res, 413, { error: "body_too_large" });
    const signature = req.headers[SIGNATURE_HEADER];
    const verified = verifyRequest(
      body,
      Array.isArray(signature) ? signature[0] : signature,
      internalSecret,
    );
    if (!verified.ok) return json(res, 401, { error: "bad_signature", reason: verified.reason });

    if (!roomIdSchema.safeParse(roomId).success) return json(res, 404, { error: "not_found" });
    let parsed;
    try {
      parsed = restoreBodySchema.safeParse(JSON.parse(body));
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    if (!parsed.success) return json(res, 400, { error: "invalid_body" });

    const snapshot = await store.getSnapshot(roomId, parsed.data.version);
    if (!snapshot) return json(res, 404, { error: "version_not_found" });

    const room = await rooms.acquire(roomId).catch((err: unknown) => {
      rooms.release(roomId);
      throw err;
    });
    try {
      room.restoreText(textFromState(snapshot.state));
      await room.flush();
    } finally {
      rooms.release(roomId);
    }
    return json(res, 200, { ok: true, version: parsed.data.version });
  }

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error("upgrade failed", err);
      reject(socket, 500);
    });
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const { origin } = req.headers;
    if (allowedOrigins && origin !== undefined && !allowedOrigins.includes(origin)) {
      return reject(socket, 403);
    }
    // y-websocket connects to `${serverUrl}/${roomId}?token=...`.
    const url = new URL(req.url ?? "/", "http://collab.invalid");
    const roomId = decodeURIComponent(url.pathname.slice(1));
    const token = url.searchParams.get("token");
    if (!roomIdSchema.safeParse(roomId).success) return reject(socket, 404);
    if (!token) return reject(socket, 401);

    const verified = await verifyRoomToken(token, tokenSecret, roomId);
    if (!verified.ok) return reject(socket, verified.reason === "wrong_room" ? 403 : 401);

    // Reserve the room (loading it from the store if needed) until the socket is attached.
    let room;
    try {
      room = await rooms.acquire(roomId);
    } catch (err) {
      rooms.release(roomId);
      throw err;
    }
    if (socket.destroyed) {
      rooms.release(roomId);
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
        rooms.evictIfIdle(roomId);
      });
      ws.on("error", () => ws.terminate());
      room.addConnection(ws, verified.claims);
      rooms.release(roomId);
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

  /** Graceful shutdown: persist every room, then stop accepting connections. */
  async function close() {
    clearInterval(heartbeat);
    await rooms.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, rejectClose) =>
      server.close((err) => (err ? rejectClose(err) : resolve())),
    );
  }

  return { server, rooms, store, metrics, close };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Reads the request body as UTF-8, or null if it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, rejectRead) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectRead);
  });
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
