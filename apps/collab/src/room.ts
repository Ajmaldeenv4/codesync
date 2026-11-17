// One collaborative room: a Y.Doc plus awareness, shared by every connected socket.
// Speaks the y-websocket wire protocol (y-protocols sync + awareness), written for this server.
import { chatMessageSchema, DOC_CHAT_KEY, DOC_TEXT_KEY } from "@codesync/shared/doc";
import type { RoomTokenClaims } from "@codesync/shared/token";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { LOAD_ORIGIN, RoomPersistence, type PersistenceOptions } from "./persistence";
import type { ChatRecord, DocStore } from "./store";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Transaction origin for a history restore (persisted and broadcast like any edit). */
export const RESTORE_ORIGIN = Symbol("codesync:restore");

interface Connection {
  user: RoomTokenClaims;
  /** Awareness client ids this socket controls, removed when it disconnects. */
  awarenessIds: Set<number>;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export interface RoomHooks {
  /** Called for every live (not loaded-from-store) document update. */
  onDocUpdate?: (roomId: string, update: Uint8Array) => void;
  /** Chat messages added by a connected user, attributed to their verified identity. */
  onChat?: (messages: ChatRecord[]) => void;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly conns = new Map<WebSocket, Connection>();
  private persistence: RoomPersistence | null = null;

  constructor(
    readonly id: string,
    private readonly hooks: RoomHooks = {},
  ) {
    // The server itself has no presence.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== LOAD_ORIGIN) {
        this.persistence?.record(update);
        this.hooks.onDocUpdate?.(this.id, update);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const conn = origin instanceof WebSocket ? this.conns.get(origin) : undefined;
      if (conn) {
        for (const id of added) conn.awarenessIds.add(id);
        for (const id of removed) conn.awarenessIds.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.doc
      .getArray(DOC_CHAT_KEY)
      .observe((event, transaction) => this.mirrorChat(event, transaction));
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  get text(): Y.Text {
    return this.doc.getText(DOC_TEXT_KEY);
  }

  /** Loads persisted state into the doc and starts recording new updates. */
  async load(store: DocStore, options?: PersistenceOptions): Promise<void> {
    this.persistence = await RoomPersistence.load(this.id, store, this.doc, options);
  }

  /** Writes any queued updates now. */
  flush(): Promise<void> {
    return this.persistence?.flush() ?? Promise.resolve();
  }

  addConnection(ws: WebSocket, user: RoomTokenClaims): void {
    this.conns.set(ws, { user, awarenessIds: new Set() });

    // Start the sync handshake: send our state vector, the client replies with what we lack.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    this.send(ws, encoding.toUint8Array(sync));

    // Tell the newcomer who is already here.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      this.send(ws, encoding.toUint8Array(encoder));
    }
  }

  /** Applies one client message. Throws on malformed input; the caller drops the socket. */
  handleMessage(ws: WebSocket, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // Origin = the socket, so updates are attributed to the connection that sent them.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
        // Only a sync-step-1 produces a reply (more than the message type byte).
        if (encoding.length(encoder) > 1) this.send(ws, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          ws,
        );
        break;
      }
      default:
        throw new Error(`Unknown message type ${type}`);
    }
  }

  removeConnection(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
  }

  /**
   * Replaces the code with an older version. CRDTs can't rewind, so this is a new edit that
   * deletes the current text and inserts the old: connected clients see it live, and it's
   * persisted (and undoable by another restore) like any other change. Chat is untouched.
   */
  restoreText(text: string): void {
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, text);
    }, RESTORE_ORIGIN);
  }

  /** Disconnects everyone and persists a final snapshot. */
  async close(): Promise<void> {
    for (const ws of this.conns.keys()) ws.close(1001, "room closed");
    this.conns.clear();
    try {
      await this.persistence?.close();
    } finally {
      this.awareness.destroy();
      this.doc.destroy();
    }
  }

  private mirrorChat(event: Y.YArrayEvent<unknown>, transaction: Y.Transaction): void {
    if (!this.hooks.onChat || transaction.origin === LOAD_ORIGIN) return;
    // Attribute the message to the verified user of the socket that sent it, not to whatever
    // userId the client wrote into the message.
    const conn =
      transaction.origin instanceof WebSocket ? this.conns.get(transaction.origin) : undefined;
    if (!conn) return;

    const records: ChatRecord[] = [];
    for (const item of event.changes.added) {
      for (const value of item.content.getContent()) {
        const parsed = chatMessageSchema.safeParse(value);
        if (!parsed.success) continue;
        records.push({
          id: parsed.data.id,
          roomId: this.id,
          userId: conn.user.sub,
          text: parsed.data.text,
          createdAt: new Date(),
        });
      }
    }
    if (records.length > 0) this.hooks.onChat(records);
  }

  private broadcast(message: Uint8Array): void {
    for (const ws of this.conns.keys()) this.send(ws, message);
  }

  private send(ws: WebSocket, message: Uint8Array): void {
    if (ws.readyState !== WebSocket.OPEN) {
      if (ws.readyState !== WebSocket.CONNECTING) this.removeConnection(ws);
      return;
    }
    ws.send(message, (err) => {
      if (err) ws.terminate();
    });
  }
}

/**
 * Keeps one Room per id in memory while anyone is connected (or about to be). Rooms are loaded
 * from the store on first use and snapshotted back when evicted.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly opening = new Map<string, Promise<Room>>();
  private readonly closing = new Map<string, Promise<void>>();
  /** Callers between acquire() and release(): a room with reservations is never evicted. */
  private readonly reservations = new Map<string, number>();

  constructor(
    private readonly store: DocStore,
    private readonly hooks: RoomHooks = {},
    private readonly persistenceOptions: PersistenceOptions = {},
  ) {}

  get size(): number {
    return this.rooms.size;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Returns the live room, loading it if needed, and reserves it so it can't be evicted until
   * the caller calls release(). The reservation is taken synchronously, before any await.
   */
  acquire(roomId: string): Promise<Room> {
    this.reservations.set(roomId, (this.reservations.get(roomId) ?? 0) + 1);
    const live = this.rooms.get(roomId);
    if (live) return Promise.resolve(live);
    const inFlight = this.opening.get(roomId);
    if (inFlight) return inFlight;

    const opening = (async () => {
      // If the room is still saving after its last user left, load after that finishes.
      await this.closing.get(roomId);
      const room = new Room(roomId, this.hooks);
      try {
        await room.load(this.store, this.persistenceOptions);
      } catch (err) {
        await room.close().catch(() => undefined);
        throw err;
      }
      this.rooms.set(roomId, room);
      return room;
    })();
    this.opening.set(roomId, opening);
    // Each caller releases its own reservation, on success or failure.
    const forget = () => {
      if (this.opening.get(roomId) === opening) this.opening.delete(roomId);
    };
    opening.then(forget, forget);
    return opening;
  }

  /** Drops a reservation and evicts the room if nobody is using it. */
  release(roomId: string): void {
    const count = (this.reservations.get(roomId) ?? 1) - 1;
    if (count > 0) this.reservations.set(roomId, count);
    else this.reservations.delete(roomId);
    this.evictIfIdle(roomId);
  }

  /** Called when a socket closes. */
  evictIfIdle(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.connectionCount > 0 || this.reservations.has(roomId)) return;
    this.rooms.delete(roomId);
    const closing = room
      .close()
      .catch((err: unknown) => console.error(`failed to close room ${roomId}`, err))
      .finally(() => {
        if (this.closing.get(roomId) === closing) this.closing.delete(roomId);
      });
    this.closing.set(roomId, closing);
  }

  /** Flushes and snapshots every room (graceful shutdown). */
  async closeAll(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.allSettled(rooms.map((room) => room.close()));
    await Promise.allSettled([...this.closing.values()]);
  }
}
