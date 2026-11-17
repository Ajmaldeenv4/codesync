// One collaborative room: a Y.Doc plus awareness, shared by every connected socket.
// Speaks the y-websocket wire protocol (y-protocols sync + awareness), written for this server.
import type { RoomTokenClaims } from "@codesync/shared/token";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

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
  /** Called for every document update applied to the room (for metrics, later persistence). */
  onDocUpdate?: (roomId: string, update: Uint8Array) => void;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly conns = new Map<WebSocket, Connection>();

  constructor(
    readonly id: string,
    private readonly hooks: RoomHooks = {},
  ) {
    // The server itself has no presence.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array) => {
      this.hooks.onDocUpdate?.(this.id, update);
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
  }

  get connectionCount(): number {
    return this.conns.size;
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

  destroy(): void {
    for (const ws of this.conns.keys()) ws.close(1001, "room closed");
    this.conns.clear();
    this.awareness.destroy();
    this.doc.destroy();
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

/** Keeps one Room per id in memory while anyone is connected. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly hooks: RoomHooks = {}) {}

  get size(): number {
    return this.rooms.size;
  }

  /** Async so Phase 3 can load the persisted document before the first client syncs. */
  async open(roomId: string): Promise<Room> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this.hooks);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Evicts the room once its last connection is gone. */
  releaseIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.connectionCount === 0) {
      this.rooms.delete(roomId);
      room.destroy();
    }
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  closeAll(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }
}
