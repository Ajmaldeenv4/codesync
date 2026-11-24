import { getPrisma } from "@codesync/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { PrismaStore } from "../src/prisma-store";
import { MAX_VERSIONS } from "../src/store";
import { createRoomFixture, hasDatabase } from "./db-fixtures";

describe.skipIf(!hasDatabase)("PrismaStore (Postgres)", () => {
  let fixture: Awaited<ReturnType<typeof createRoomFixture>>;
  let store: PrismaStore;

  beforeAll(async () => {
    fixture = await createRoomFixture();
    store = new PrismaStore(getPrisma());
  });

  afterAll(() => fixture.cleanup());

  test("append, compact and load round-trip a document", async () => {
    const { roomId } = fixture;
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    doc.getText("monaco").insert(0, "print(1)");
    doc.getText("monaco").insert(8, "\nprint(2)");

    // Concurrent writers get distinct sequence numbers; a repeated write is harmless.
    await Promise.all([
      store.appendUpdate(roomId, updates[0] as Uint8Array),
      store.appendUpdate(roomId, updates[0] as Uint8Array),
      store.appendUpdate(roomId, updates[1] as Uint8Array),
    ]);
    let loaded = await store.load(roomId);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.updates.map((u) => u.seq)).toEqual([1, 2, 3]);

    // A server that has seen nothing compacts: the stored updates must end up in the snapshot.
    const version = await store.compact(roomId, Y.encodeStateAsUpdate(new Y.Doc()));
    expect(version).toBe(1);
    loaded = await store.load(roomId);
    expect(loaded.snapshot?.version).toBe(1);
    expect(loaded.updates).toEqual([]);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, (loaded.snapshot as { state: Uint8Array }).state);
    for (const u of loaded.updates) Y.applyUpdate(restored, u.update);
    expect(restored.getText("monaco").toString()).toBe("print(1)\nprint(2)");

    expect((await store.getSnapshot(roomId, 1))?.version).toBe(1);
    expect(await store.getSnapshot(roomId, 2)).toBeNull();
  });

  test("snapshot versions increase", async () => {
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    const next = await store.compact(fixture.roomId, state);
    expect(next).toBeGreaterThan(1);
  });

  test("history stays within its limits and keeps the newest version", async () => {
    const { roomId } = fixture;
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    let newest = 0;
    for (let i = 0; i < MAX_VERSIONS + 5; i++) newest = await store.compact(roomId, state);
    const versions = await getPrisma().snapshot.findMany({
      where: { roomId },
      orderBy: { version: "asc" },
      select: { version: true },
    });
    expect(versions).toHaveLength(MAX_VERSIONS);
    expect(versions[0]?.version).toBe(1);
    expect(versions.at(-1)?.version).toBe(newest);
  });

  test("saved chat can be looked up, but only in its own room", async () => {
    const { roomId, userId } = fixture;
    const id = `find-${roomId}`.replace(/_/g, "-");
    await store.saveChat([{ id, roomId, userId, text: "find me", createdAt: new Date() }]);
    expect(await store.findChat(roomId, [id, "missing-1"])).toMatchObject([
      { id, userId, text: "find me" },
    ]);
    expect(await store.findChat("otherroom1", [id])).toEqual([]);
    await getPrisma().chatMessage.delete({ where: { id } });
  });

  test("chat mirroring is idempotent", async () => {
    const message = {
      id: `msg-${fixture.roomId}`,
      roomId: fixture.roomId,
      userId: fixture.userId,
      text: "hello",
      createdAt: new Date(),
    };
    await store.saveChat([message]);
    await store.saveChat([message]);
    const rows = await getPrisma().chatMessage.findMany({ where: { roomId: fixture.roomId } });
    expect(rows).toHaveLength(1);
  });
});
