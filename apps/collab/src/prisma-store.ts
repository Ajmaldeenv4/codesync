import type { Prisma, PrismaClient } from "@codesync/db";
import {
  mergeStates,
  type ChatRecord,
  type DocStore,
  type LoadedDoc,
  type StoredSnapshot,
} from "./store";

/** Postgres-backed store: doc_updates (incremental), snapshots (compacted), chat_messages. */
export class PrismaStore implements DocStore {
  constructor(private readonly db: PrismaClient) {}

  load(roomId: string): Promise<LoadedDoc> {
    return this.locked(roomId, (tx) => readDoc(tx, roomId));
  }

  async appendUpdate(roomId: string, update: Uint8Array): Promise<void> {
    await this.locked(roomId, async (tx) => {
      const last = await tx.docUpdate.findFirst({
        where: { roomId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      await tx.docUpdate.create({
        data: { roomId, seq: (last?.seq ?? 0) + 1, update: toBytes(update) },
      });
    });
  }

  compact(roomId: string, state: Uint8Array): Promise<number> {
    return this.locked(roomId, async (tx) => {
      const { snapshot, updates } = await readDoc(tx, roomId);
      const version = (snapshot?.version ?? 0) + 1;
      const merged = mergeStates(snapshot, updates, state);
      await tx.snapshot.create({ data: { roomId, version, state: toBytes(merged) } });
      await tx.docUpdate.deleteMany({ where: { roomId } });
      return version;
    });
  }

  /**
   * Runs `work` in a transaction holding the room's lock, so servers that overlap during a deploy
   * take turns and a reader never sees a half-finished compaction.
   */
  private locked<T>(
    roomId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`;
        return work(tx);
      },
      // A sleeping serverless database (Neon) needs a few seconds to wake.
      { maxWait: 15_000, timeout: 20_000 },
    );
  }

  async getSnapshot(roomId: string, version: number): Promise<StoredSnapshot | null> {
    const row = await this.db.snapshot.findUnique({
      where: { roomId_version: { roomId, version } },
    });
    return row
      ? { version: row.version, state: new Uint8Array(row.state), createdAt: row.createdAt }
      : null;
  }

  async saveChat(messages: ChatRecord[]): Promise<void> {
    if (messages.length === 0) return;
    await this.db.chatMessage.createMany({ data: messages, skipDuplicates: true });
  }
}

async function readDoc(tx: Prisma.TransactionClient, roomId: string): Promise<LoadedDoc> {
  const snapshot = await tx.snapshot.findFirst({
    where: { roomId },
    orderBy: { version: "desc" },
  });
  const updates = await tx.docUpdate.findMany({ where: { roomId }, orderBy: { seq: "asc" } });
  return {
    snapshot: snapshot
      ? {
          version: snapshot.version,
          state: new Uint8Array(snapshot.state),
          createdAt: snapshot.createdAt,
        }
      : null,
    updates: updates.map((u) => ({ seq: u.seq, update: new Uint8Array(u.update) })),
  };
}

/** Prisma wants a Uint8Array backed by a plain ArrayBuffer. */
function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}
