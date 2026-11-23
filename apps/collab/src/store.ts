// Where room documents live between sessions. PrismaStore is the real one; MemoryStore backs
// unit tests (and runs the server without a database).
import * as Y from "yjs";

export interface StoredSnapshot {
  version: number;
  state: Uint8Array;
  createdAt: Date;
}

export interface StoredUpdate {
  seq: number;
  update: Uint8Array;
}

export interface LoadedDoc {
  /** Latest compacted state, if any. */
  snapshot: StoredSnapshot | null;
  /** Incremental updates written since that snapshot, in seq order. */
  updates: StoredUpdate[];
}

export interface ChatRecord {
  id: string;
  roomId: string;
  userId: string;
  text: string;
  createdAt: Date;
}

export interface DocStore {
  load(roomId: string): Promise<LoadedDoc>;
  /**
   * Adds an update after every stored one. The store picks the sequence number, so servers that
   * overlap during a deploy never collide. Storing an update twice is harmless (Yjs ignores it).
   */
  appendUpdate(roomId: string, update: Uint8Array): Promise<void>;
  /**
   * Atomically folds `state`, the latest snapshot and every stored update into the next snapshot
   * version, then deletes those updates. Merging what is stored, rather than trusting `state` to
   * contain it, keeps edits written by another server.
   */
  compact(roomId: string, state: Uint8Array): Promise<number>;
  getSnapshot(roomId: string, version: number): Promise<StoredSnapshot | null>;
  /** Idempotent on message id. */
  saveChat(messages: ChatRecord[]): Promise<void>;
}

/** One state containing everything in the snapshot, the updates and `state`. */
export function mergeStates(
  snapshot: { state: Uint8Array } | null | undefined,
  updates: { update: Uint8Array }[],
  state: Uint8Array,
): Uint8Array {
  const doc = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    for (const { update } of updates) Y.applyUpdate(doc, update);
    Y.applyUpdate(doc, state);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

export class MemoryStore implements DocStore {
  readonly updates = new Map<string, StoredUpdate[]>();
  readonly snapshots = new Map<string, StoredSnapshot[]>();
  readonly chat = new Map<string, ChatRecord>();

  async load(roomId: string): Promise<LoadedDoc> {
    const snapshots = this.snapshots.get(roomId) ?? [];
    return {
      snapshot: snapshots.at(-1) ?? null,
      updates: [...(this.updates.get(roomId) ?? [])].sort((a, b) => a.seq - b.seq),
    };
  }

  async appendUpdate(roomId: string, update: Uint8Array): Promise<void> {
    const rows = this.updates.get(roomId) ?? [];
    rows.push({ seq: (rows.at(-1)?.seq ?? 0) + 1, update });
    this.updates.set(roomId, rows);
  }

  async compact(roomId: string, state: Uint8Array): Promise<number> {
    const snapshots = this.snapshots.get(roomId) ?? [];
    const latest = snapshots.at(-1);
    const version = (latest?.version ?? 0) + 1;
    const merged = mergeStates(latest, this.updates.get(roomId) ?? [], state);
    snapshots.push({ version, state: merged, createdAt: new Date() });
    this.snapshots.set(roomId, snapshots);
    this.updates.set(roomId, []);
    return version;
  }

  async getSnapshot(roomId: string, version: number): Promise<StoredSnapshot | null> {
    return this.snapshots.get(roomId)?.find((s) => s.version === version) ?? null;
  }

  async saveChat(messages: ChatRecord[]): Promise<void> {
    for (const m of messages) if (!this.chat.has(m.id)) this.chat.set(m.id, m);
  }
}
