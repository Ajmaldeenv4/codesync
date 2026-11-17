import { signRequest, SIGNATURE_HEADER } from "@codesync/shared/hmac";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createCollabServer, type CollabServer } from "../src/server";
import { MemoryStore } from "../src/store";
import { connectClient, SECRET, waitFor, type TestClient } from "./helpers";

const INTERNAL = "internal-secret-for-tests-that-is-long-enough";
const store = new MemoryStore();
let collab: CollabServer;
let httpUrl = "";
let wsUrl = "";
const clients: TestClient[] = [];

async function client(room: string, sub = "user_a", name = "Ada") {
  const c = await connectClient(wsUrl, room, sub, name);
  clients.push(c);
  return c;
}

function leave(c: TestClient) {
  c.provider.destroy();
  clients.splice(clients.indexOf(c), 1);
}

beforeAll(async () => {
  collab = createCollabServer({
    tokenSecret: SECRET,
    internalSecret: INTERNAL,
    store,
    persistence: { batchMs: 20 },
    pingIntervalMs: 60_000,
  });
  await new Promise<void>((resolve) => collab.server.listen(0, "127.0.0.1", resolve));
  const { port } = collab.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  await collab.close();
});

describe("room lifecycle", () => {
  test("when the last client leaves, the room is snapshotted; the next visit restores it", async () => {
    const room = "persist001";
    const a = await client(room);
    a.text.insert(0, "def main():\n    pass\n");
    await waitFor(() => (store.updates.get(room)?.length ?? 0) > 0, "batched write");

    leave(a);
    await waitFor(() => (store.snapshots.get(room)?.length ?? 0) === 1, "snapshot on eviction");
    await waitFor(() => collab.rooms.get(room) === undefined, "eviction");

    const b = await client(room, "user_b", "Bob");
    expect(b.text.toString()).toBe("def main():\n    pass\n");
  });
});

describe("chat", () => {
  test("messages sync to other clients and are mirrored under the sender's verified id", async () => {
    const room = "chatroom01";
    const ada = await client(room, "user_ada", "Ada");
    const bob = await client(room, "user_bob", "Bob");

    // The client claims to be someone else; the server must use the token's identity.
    ada.doc
      .getArray("chat")
      .push([
        { id: "msg-00000001", userId: "user_bob", name: "Ada", text: "hi bob", ts: Date.now() },
      ]);

    await waitFor(() => bob.doc.getArray("chat").length === 1, "chat to reach Bob");
    await waitFor(() => store.chat.has("msg-00000001"), "chat mirror");
    expect(store.chat.get("msg-00000001")).toMatchObject({
      roomId: room,
      userId: "user_ada",
      text: "hi bob",
    });
  });

  test("malformed chat entries are not mirrored", async () => {
    const room = "chatroom02";
    const ada = await client(room);
    ada.doc.getArray("chat").push([{ id: "bad-entry-1", text: "" }, "not an object"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([...store.chat.values()].filter((m) => m.roomId === room)).toHaveLength(0);
  });
});

describe("internal restore", () => {
  async function restore(room: string, body: string, signature?: string) {
    return fetch(`${httpUrl}/internal/rooms/${room}/restore`, {
      method: "POST",
      headers: signature ? { [SIGNATURE_HEADER]: signature } : {},
      body,
    });
  }

  test("an unsigned or mis-signed request is rejected", async () => {
    const body = JSON.stringify({ version: 1 });
    expect((await restore("restore001", body)).status).toBe(401);
    expect((await restore("restore001", body, signRequest("other", INTERNAL))).status).toBe(401);
  });

  test("a signed restore replaces the live text for connected clients", async () => {
    const room = "restore002";
    // Version 1 of the room holds "old code".
    const v1 = new Y.Doc();
    v1.getText("monaco").insert(0, "old code");
    await store.compact(room, Y.encodeStateAsUpdate(v1), 0);

    const ada = await client(room);
    ada.text.insert(0, "new code, ");
    await waitFor(() => ada.text.toString() === "new code, old code", "merge with v1");

    const body = JSON.stringify({ version: 1 });
    const res = await restore(room, body, signRequest(body, INTERNAL));
    expect(res.status).toBe(200);
    await waitFor(() => ada.text.toString() === "old code", "restored text to reach the client");
  });

  test("an unknown version is a 404", async () => {
    const body = JSON.stringify({ version: 99 });
    const res = await restore("restore003", body, signRequest(body, INTERNAL));
    expect(res.status).toBe(404);
  });
});
