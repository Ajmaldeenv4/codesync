import { getPrisma } from "@codesync/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { PrismaStore } from "../src/prisma-store";
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

    await store.appendUpdate(roomId, 1, updates[0] as Uint8Array);
    await store.appendUpdate(roomId, 1, updates[0] as Uint8Array); // retry: idempotent
    await store.appendUpdate(roomId, 2, updates[1] as Uint8Array);
    let loaded = await store.load(roomId);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.updates.map((u) => u.seq)).toEqual([1, 2]);

    const version = await store.compact(roomId, Y.encodeStateAsUpdate(doc), 1);
    expect(version).toBe(1);
    loaded = await store.load(roomId);
    expect(loaded.snapshot?.version).toBe(1);
    expect(loaded.updates.map((u) => u.seq)).toEqual([2]); // only rows after the snapshot

    const restored = new Y.Doc();
    Y.applyUpdate(restored, (loaded.snapshot as { state: Uint8Array }).state);
    for (const u of loaded.updates) Y.applyUpdate(restored, u.update);
    expect(restored.getText("monaco").toString()).toBe("print(1)\nprint(2)");

    expect((await store.getSnapshot(roomId, 1))?.version).toBe(1);
    expect(await store.getSnapshot(roomId, 2)).toBeNull();
  });

  test("snapshot versions increase", async () => {
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    const next = await store.compact(fixture.roomId, state, 0);
    expect(next).toBeGreaterThan(1);
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
