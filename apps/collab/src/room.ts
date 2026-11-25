// One collaborative room: a Y.Doc plus awareness, shared by every connected socket.
// Speaks the y-websocket wire protocol (y-protocols sync + awareness), written for this server.
import {
  CHAT_NAME_LENGTH,
  chatMessageSchema,
  CLOSE_POLICY,
  CLOSE_ROOM_FULL,
  DOC_CHAT_KEY,
  DOC_TEXT_KEY,
  type ChatMessage,
} from "@codesync/shared/doc";
import type { RoomTokenClaims } from "@codesync/shared/token";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  DEFAULT_LIMITS,
  LimitError,
  SMALL_EDIT_BYTES,
  UserLimits,
  type CollabLimits,
} from "./limits";
import { LOAD_ORIGIN, RoomPersistence, type PersistenceOptions } from "./persistence";
import type { ChatAuthor, ChatRecord, DocStore } from "./store";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Transaction origin for a history restore (persisted and broadcast like any edit). */
export const RESTORE_ORIGIN = Symbol("codesync:restore");

/** Transaction origin for correcting who a chat message says it is from. */
const AUTHOR_ORIGIN = Symbol("codesync:author");

/** A document near its size limit is measured at most this often. */
const MEASURE_INTERVAL_MS = 100;
/** Awareness ids one connection may use over its lifetime. */
const MAX_PRESENCE_CLAIMS = 16;

interface Connection {
  user: RoomTokenClaims;
  /** Awareness client ids this socket controls, removed when it disconnects. */
  awarenessIds: Set<number>;
  presenceClaims: number;
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
  /** Looks up already-saved chat messages. */
  findChat?: (roomId: string, ids: string[]) => Promise<ChatAuthor[]>;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly conns = new Map<WebSocket, Connection>();
  /** Which connection controls each awareness id. */
  private readonly presenceOwners = new Map<number, WebSocket>();
  /** The connection whose update is held back by Yjs, waiting for one it depends on. */
  private pendingFrom: WebSocket | null = null;
  /** Upper bound on the document's encoded size: the last measurement plus edits since. */
  private docSize = Infinity;
  private measuredAt = 0;
  /** Author corrections in progress. */
  private corrections: Promise<void> = Promise.resolve();
  private persistence: RoomPersistence | null = null;

  constructor(
    readonly id: string,
    private readonly hooks: RoomHooks = {},
    private readonly limits: CollabLimits = DEFAULT_LIMITS,
    private readonly users: UserLimits = new UserLimits(limits),
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

    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange) => {
      for (const id of removed) this.releasePresence(id);
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
      .observe((event, transaction) => this.onChatChange(event, transaction));
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
    this.conns.set(ws, { user, awarenessIds: new Set(), presenceClaims: 0 });

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

  /** Applies one client message. Throws if it is malformed or excessive; the caller drops the socket. */
  handleMessage(ws: WebSocket, message: Uint8Array): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    const { sub } = conn.user;
    if (!this.users.messages.take(sub) || !this.users.bytes.take(sub, message.length)) {
      throw new LimitError(CLOSE_POLICY, "too much data");
    }
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) {
          this.admitEdit(message.length);
          if (this.pendingFrom !== ws) this.dropPending();
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // Origin = the socket, so updates are attributed to the connection that sent them.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
        const { pendingStructs, pendingDs } = this.doc.store;
        if (pendingStructs || pendingDs) this.pendingFrom ??= ws;
        else this.pendingFrom = null;
        // Only a sync-step-1 produces a reply (more than the message type byte).
        if (encoding.length(encoder) > 1) {
          const reply = encoding.toUint8Array(encoder);
          if (!this.users.replyBytes.take(sub, reply.length)) {
            throw new LimitError(CLOSE_POLICY, "too many sync requests");
          }
          this.send(ws, reply);
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        const update = this.ownPresence(ws, conn, decoding.readVarUint8Array(decoder));
        if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
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
    if (this.pendingFrom === ws) this.dropPending();
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
      await this.corrections;
      await this.persistence?.close();
    } finally {
      this.awareness.destroy();
      this.doc.destroy();
    }
  }

  /** Refuses an edit that would make the document too large. */
  private admitEdit(bytes: number): void {
    // Near the limit small edits still work, so people can delete text to make room.
    const limit = bytes <= SMALL_EDIT_BYTES ? this.limits.docBytesHard : this.limits.docBytes;
    if (this.docSize + bytes > limit) {
      const now = Date.now();
      if (now - this.measuredAt < MEASURE_INTERVAL_MS) {
        throw new LimitError(CLOSE_POLICY, "document is near its size limit");
      }
      this.measuredAt = now;
      this.docSize = Y.encodeStateAsUpdate(this.doc).length;
    }
    if (this.docSize + bytes > limit) {
      throw new LimitError(CLOSE_ROOM_FULL, "document is too large");
    }
    this.docSize += bytes;
  }

  /**
   * Yjs holds back an update until the ones it depends on arrive, then applies it as part of
   * whatever brought them. Dropping it when someone else edits keeps each edit credited to the
   * connection that sent it. Nothing real is lost: clients send everything the server lacks when
   * they connect.
   */
  private dropPending(): void {
    this.doc.store.pendingStructs = null;
    this.doc.store.pendingDs = null;
    this.pendingFrom = null;
  }

  /** The part of an awareness update this connection may make, or null if there is none. */
  private ownPresence(ws: WebSocket, conn: Connection, update: Uint8Array): Uint8Array | null {
    const decoder = decoding.createDecoder(update);
    const entries: { id: number; clock: number; json: string }[] = [];
    const count = decoding.readVarUint(decoder);
    for (let i = 0; i < count; i++) {
      const id = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const json = decoding.readVarString(decoder);
      if (this.mayChangePresence(ws, conn, id, clock, json)) entries.push({ id, clock, json });
    }
    if (entries.length === 0) return null;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, entries.length);
    for (const { id, clock, json } of entries) {
      encoding.writeVarUint(encoder, id);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, json);
    }
    return encoding.toUint8Array(encoder);
  }

  private mayChangePresence(
    ws: WebSocket,
    conn: Connection,
    id: number,
    clock: number,
    json: string,
  ): boolean {
    // y-websocket echoes everyone's states back, so most entries are old news.
    const known = this.awareness.meta.get(id)?.clock ?? 0;
    const removesCurrent = clock === known && json === "null" && this.awareness.states.has(id);
    if (clock <= known && !removesCurrent) return false;
    if (json.length > this.limits.presenceBytes) return false;

    const owner = this.presenceOwners.get(id);
    if (owner === ws) return true;
    if (json === "null") return false;
    // Someone reconnecting keeps their id while their old connection is still timing out.
    const ownerUser = owner && this.conns.get(owner)?.user.sub;
    if (owner && ownerUser !== conn.user.sub) return false;
    if (conn.awarenessIds.size >= this.limits.presencePerConnection) return false;
    if (conn.presenceClaims >= MAX_PRESENCE_CLAIMS) return false;
    this.releasePresence(id);
    this.presenceOwners.set(id, ws);
    conn.awarenessIds.add(id);
    conn.presenceClaims += 1;
    return true;
  }

  private releasePresence(id: number): void {
    const owner = this.presenceOwners.get(id);
    if (!owner) return;
    this.presenceOwners.delete(id);
    this.conns.get(owner)?.awarenessIds.delete(id);
  }

  /**
   * Saves new chat messages, and makes sure each one names the person whose connection sent it:
   * the array is writable by every client, so a message may claim to be from someone else.
   */
  private onChatChange(event: Y.YArrayEvent<unknown>, transaction: Y.Transaction): void {
    const conn =
      transaction.origin instanceof WebSocket ? this.conns.get(transaction.origin) : undefined;
    if (!conn) return;
    const { user } = conn;

    const genuine: ChatMessage[] = [];
    const doubtful: ChatMessage[] = [];
    const doubtfulItems: Y.Item[] = [];
    for (const item of event.changes.added) {
      const messages = item.content.getContent().flatMap((value: unknown) => {
        const parsed = chatMessageSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
      if (messages.every((m) => m.userId === user.sub && m.name === chatName(user.name))) {
        genuine.push(...messages);
      } else {
        doubtful.push(...messages);
        doubtfulItems.push(item);
      }
    }
    this.saveChat(user, genuine);
    if (doubtfulItems.length === 0) return;

    // Taken out before anyone is sent the edit, and put back once the author is known.
    this.doc.transact((tr) => {
      for (const item of doubtfulItems) item.delete(tr);
    }, AUTHOR_ORIGIN);
    const correction = this.correctAuthors(user, doubtful);
    this.corrections = this.corrections.then(() => correction);
  }

  private async correctAuthors(user: RoomTokenClaims, messages: ChatMessage[]): Promise<void> {
    // After a crash, a client may resend a message that someone else really did write.
    let saved: ChatAuthor[] = [];
    try {
      const ids = messages.slice(0, 200).map((m) => m.id);
      saved = (await this.hooks.findChat?.(this.id, ids)) ?? [];
    } catch (err) {
      console.error(`room ${this.id}: could not look up chat authors`, err);
    }
    const chat = this.doc.getArray<unknown>(DOC_CHAT_KEY);
    const present = new Set(chat.toArray().map((value) => (value as { id?: unknown } | null)?.id));
    const corrected: ChatMessage[] = [];
    const own: ChatMessage[] = [];
    for (const message of messages) {
      if (present.has(message.id)) continue;
      present.add(message.id);
      const author = saved.find(
        (s) => s.id === message.id && s.userId === message.userId && s.text === message.text,
      );
      const { userId, name } = author ?? { userId: user.sub, name: user.name };
      corrected.push({ ...message, userId, name: chatName(name) });
      if (!author) own.push(message);
    }
    if (corrected.length > 0) this.doc.transact(() => chat.push(corrected), AUTHOR_ORIGIN);
    this.saveChat(user, own);
  }

  private saveChat(user: RoomTokenClaims, messages: ChatMessage[]): void {
    const records = messages
      .filter(() => this.users.chat.take(user.sub))
      .map(({ id, text }) => ({
        id,
        roomId: this.id,
        userId: user.sub,
        text,
        createdAt: new Date(),
      }));
    if (records.length > 0) this.hooks.onChat?.(records);
  }

  private broadcast(message: Uint8Array): void {
    for (const ws of this.conns.keys()) this.send(ws, message);
  }

  private send(ws: WebSocket, message: Uint8Array): void {
    if (ws.readyState !== WebSocket.OPEN) {
      if (ws.readyState !== WebSocket.CONNECTING) this.removeConnection(ws);
      return;
    }
    if (ws.bufferedAmount > this.limits.bufferedBytes) {
      ws.terminate();
      return;
    }
    ws.send(message, (err) => {
      if (err) ws.terminate();
    });
  }
}

function chatName(name: string): string {
  return name.slice(0, CHAT_NAME_LENGTH);
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
    private readonly limits: CollabLimits = DEFAULT_LIMITS,
    private readonly users: UserLimits = new UserLimits(limits),
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
      const room = new Room(roomId, this.hooks, this.limits, this.users);
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
