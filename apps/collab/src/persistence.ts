// Per-room persistence: batches Yjs updates into doc_updates rows and compacts them into
// snapshots. One writer per room (this process), with writes serialised on a promise chain.
import * as Y from "yjs";
import type { DocStore } from "./store";

/** Transaction origin for updates applied while loading from the store (never re-persisted). */
export const LOAD_ORIGIN = Symbol("codesync:load");

export interface PersistenceOptions {
  /**
   * Updates are collected for this long, then written as one merged row. A fixed window (not a
   * resetting debounce) so continuous typing still reaches the database every `batchMs`.
   */
  batchMs?: number;
  /** Compact into a snapshot once this many rows have been written since the last one. */
  compactEvery?: number;
  /** Delay before retrying a failed write. */
  retryMs?: number;
  onError?: (err: unknown, roomId: string) => void;
}

export class RoomPersistence {
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly batchMs: number;
  private readonly compactEvery: number;
  private readonly retryMs: number;
  private readonly onError: (err: unknown, roomId: string) => void;

  private constructor(
    private readonly roomId: string,
    private readonly store: DocStore,
    private readonly doc: Y.Doc,
    private rowsSinceSnapshot: number,
    options: PersistenceOptions,
  ) {
    this.batchMs = options.batchMs ?? 500;
    this.compactEvery = options.compactEvery ?? 200;
    this.retryMs = options.retryMs ?? 2000;
    this.onError =
      options.onError ?? ((err, id) => console.error(`persistence error in room ${id}`, err));
  }

  /** Loads the room's latest snapshot plus later updates into `doc`, then returns a writer. */
  static async load(
    roomId: string,
    store: DocStore,
    doc: Y.Doc,
    options: PersistenceOptions = {},
  ): Promise<RoomPersistence> {
    const { snapshot, updates } = await store.load(roomId);
    if (snapshot) Y.applyUpdate(doc, snapshot.state, LOAD_ORIGIN);
    for (const { update } of updates) Y.applyUpdate(doc, update, LOAD_ORIGIN);
    return new RoomPersistence(roomId, store, doc, updates.length, options);
  }

  /** Number of rows written since the last snapshot (for tests and metrics). */
  get pendingRows(): number {
    return this.rowsSinceSnapshot;
  }

  /** Queues one document update; it's written within `batchMs`. */
  record(update: Uint8Array): void {
    if (this.closed) return;
    this.pending.push(update);
    this.timer ??= setTimeout(() => void this.flush(), this.batchMs);
  }

  /** Writes everything queued so far. Resolves once it (and earlier writes) are stored. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return this.chain;
    const batch = this.pending.splice(0);
    const update = batch.length === 1 && batch[0] ? batch[0] : Y.mergeUpdates(batch);
    this.chain = this.chain.then(() => this.write(update));
    return this.chain;
  }

  /** Flushes, then folds everything into a new snapshot (if anything changed since the last). */
  compact(): Promise<void> {
    void this.flush();
    this.chain = this.chain.then(() => this.compactNow());
    return this.chain;
  }

  /** Final flush + compaction when the room is evicted or the server shuts down. */
  async close(): Promise<void> {
    await this.compact();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async write(update: Uint8Array): Promise<void> {
    try {
      await this.store.appendUpdate(this.roomId, update);
    } catch (err) {
      this.onError(err, this.roomId);
      // Keep the data: put it back at the front of the queue and try again later. If the write
      // did land and only its confirmation was lost, storing it twice is harmless.
      this.pending.unshift(update);
      if (!this.closed) this.timer ??= setTimeout(() => void this.flush(), this.retryMs);
      return;
    }
    this.rowsSinceSnapshot += 1;
    if (this.rowsSinceSnapshot >= this.compactEvery) await this.compactNow();
  }

  private async compactNow(): Promise<void> {
    // Updates still pending here are ones whose write failed; a snapshot saves them too.
    if (this.rowsSinceSnapshot === 0 && this.pending.length === 0) return;
    try {
      await this.store.compact(this.roomId, Y.encodeStateAsUpdate(this.doc));
      this.rowsSinceSnapshot = 0;
    } catch (err) {
      // The rows are still there, so nothing is lost; the next compaction retries.
      this.onError(err, this.roomId);
    }
  }
}
