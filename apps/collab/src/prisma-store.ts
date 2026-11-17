import type { PrismaClient } from "@codesync/db";
import type { ChatRecord, DocStore, LoadedDoc, StoredSnapshot } from "./store";

/** Postgres-backed store: doc_updates (incremental), snapshots (compacted), chat_messages. */
export class PrismaStore implements DocStore {
  constructor(private readonly db: PrismaClient) {}

  async load(roomId: string): Promise<LoadedDoc> {
    const [snapshot, updates] = await Promise.all([
      this.db.snapshot.findFirst({ where: { roomId }, orderBy: { version: "desc" } }),
      this.db.docUpdate.findMany({ where: { roomId }, orderBy: { seq: "asc" } }),
    ]);
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

  async appendUpdate(roomId: string, seq: number, update: Uint8Array): Promise<void> {
    await this.db.docUpdate.createMany({
      data: [{ roomId, seq, update: toBytes(update) }],
      skipDuplicates: true,
    });
  }

  async compact(roomId: string, state: Uint8Array, upToSeq: number): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const latest = await tx.snapshot.findFirst({
        where: { roomId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      await tx.snapshot.create({ data: { roomId, version, state: toBytes(state) } });
      await tx.docUpdate.deleteMany({ where: { roomId, seq: { lte: upToSeq } } });
      return version;
    });
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

/** Prisma wants a Uint8Array backed by a plain ArrayBuffer. */
function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}
