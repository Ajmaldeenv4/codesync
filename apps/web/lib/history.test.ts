import { getPrisma, type PrismaClient } from "@codesync/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { collabInternalUrl, getHistoryVersion, listHistory } from "./history";

describe("collabInternalUrl", () => {
  test("prefers COLLAB_INTERNAL_URL", () => {
    expect(collabInternalUrl({ COLLAB_INTERNAL_URL: "http://collab.internal:1234/" })).toBe(
      "http://collab.internal:1234",
    );
  });

  test("derives http(s) from the public ws(s) URL", () => {
    expect(collabInternalUrl({ NEXT_PUBLIC_COLLAB_URL: "ws://localhost:1234" })).toBe(
      "http://localhost:1234",
    );
    expect(collabInternalUrl({ NEXT_PUBLIC_COLLAB_URL: "wss://collab.example.com" })).toBe(
      "https://collab.example.com",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("history (Postgres)", () => {
  let db: PrismaClient;
  let userId = "";
  const roomId = `hi${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  function stateOf(text: string): Uint8Array<ArrayBuffer> {
    const doc = new Y.Doc();
    doc.getText("monaco").insert(0, text);
    const update = Y.encodeStateAsUpdate(doc);
    const copy = new Uint8Array(new ArrayBuffer(update.byteLength));
    copy.set(update);
    return copy;
  }

  beforeAll(async () => {
    db = getPrisma();
    const user = await db.user.create({
      data: { name: "Historian", email: `history-${roomId}@vitest.codesync.invalid` },
    });
    userId = user.id;
    await db.room.create({ data: { id: roomId, name: "h", language: "python", ownerId: userId } });
    await db.snapshot.createMany({
      data: [
        { roomId, version: 1, state: stateOf("print('v1')") },
        { roomId, version: 2, state: stateOf("print('v2')") },
      ],
    });
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } });
  });

  test("lists versions newest first", async () => {
    expect((await listHistory(db, roomId)).map((v) => v.version)).toEqual([2, 1]);
  });

  test("decodes a version's code", async () => {
    expect((await getHistoryVersion(db, roomId, 1))?.text).toBe("print('v1')");
    expect(await getHistoryVersion(db, roomId, 3)).toBeNull();
  });
});
