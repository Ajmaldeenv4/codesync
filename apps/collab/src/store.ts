// Where room documents live between sessions. PrismaStore is the real one; MemoryStore backs
// unit tests (and runs the server without a database).

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
  /** Idempotent on (roomId, seq): retrying a write that already landed is a no-op. */
  appendUpdate(roomId: string, seq: number, update: Uint8Array): Promise<void>;
  /** Atomically stores `state` as the next snapshot version and deletes updates <= upToSeq. */
  compact(roomId: string, state: Uint8Array, upToSeq: number): Promise<number>;
  getSnapshot(roomId: string, version: number): Promise<StoredSnapshot | null>;
  /** Idempotent on message id. */
  saveChat(messages: ChatRecord[]): Promise<void>;
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

  async appendUpdate(roomId: string, seq: number, update: Uint8Array): Promise<void> {
    const rows = this.updates.get(roomId) ?? [];
    if (!rows.some((r) => r.seq === seq)) rows.push({ seq, update });
    this.updates.set(roomId, rows);
  }

  async compact(roomId: string, state: Uint8Array, upToSeq: number): Promise<number> {
    const snapshots = this.snapshots.get(roomId) ?? [];
    const version = (snapshots.at(-1)?.version ?? 0) + 1;
    snapshots.push({ version, state, createdAt: new Date() });
    this.snapshots.set(roomId, snapshots);
    this.updates.set(
      roomId,
      (this.updates.get(roomId) ?? []).filter((r) => r.seq > upToSeq),
    );
    return version;
  }

  async getSnapshot(roomId: string, version: number): Promise<StoredSnapshot | null> {
    return this.snapshots.get(roomId)?.find((s) => s.version === version) ?? null;
  }

  async saveChat(messages: ChatRecord[]): Promise<void> {
    for (const m of messages) if (!this.chat.has(m.id)) this.chat.set(m.id, m);
  }
}
