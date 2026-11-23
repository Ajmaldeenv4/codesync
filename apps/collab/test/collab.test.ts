import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import {
  connectClient,
  startServer,
  tokenFor,
  upgradeStatus,
  waitFor,
  type RunningServer,
  type TestClient,
} from "./helpers";

let running: RunningServer;
const clients: TestClient[] = [];
let roomCounter = 0;
/** A fresh valid room id (nanoid(10) shape) per test. */
const nextRoom = () => `room${String(++roomCounter).padStart(6, "0")}`;

async function client(roomId: string, sub: string, name: string) {
  const c = await connectClient(running.wsUrl, roomId, sub, name);
  clients.push(c);
  return c;
}

beforeAll(async () => {
  running = await startServer();
});

afterEach(() => {
  for (const c of clients.splice(0)) c.provider.destroy();
});

afterAll(async () => {
  await running.collab.close();
});

describe("document sync", () => {
  test("an edit in one client appears in the other", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    const b = await client(room, "user_b", "Bob");

    a.text.insert(0, "console.log('hi')");
    await waitFor(() => b.text.toString() === "console.log('hi')", "B to receive A's edit");
  });

  test("concurrent edits converge to identical text", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    const b = await client(room, "user_b", "Bob");
    a.text.insert(0, "middle");
    await waitFor(() => b.text.length === 6, "initial sync");

    // Both edit before either sees the other's change.
    a.text.insert(0, "AAA ");
    b.text.insert(b.text.length, " BBB");

    await waitFor(() => a.text.toString() === b.text.toString(), "convergence");
    expect(a.text.toString()).toBe("AAA middle BBB");
  });

  test("a late joiner receives the existing document", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    a.text.insert(0, "print('hello')");
    await waitFor(
      () => running.collab.rooms.get(room)?.doc.getText("monaco").length === 14,
      "server",
    );

    const late = await client(room, "user_c", "Cy");
    expect(late.text.toString()).toBe("print('hello')");
  });
});

describe("awareness", () => {
  test("presence propagates and is removed when a client leaves", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    const b = await client(room, "user_b", "Bob");
    const aId = a.doc.clientID;

    a.provider.awareness.setLocalStateField("user", { id: "user_a", name: "Ada", color: "#f00" });
    await waitFor(
      () => b.provider.awareness.getStates().get(aId)?.user?.name === "Ada",
      "B to see A's presence",
    );

    a.provider.destroy();
    await waitFor(() => !b.provider.awareness.getStates().has(aId), "A's presence to clear");
  });

  test("a late joiner sees who is already in the room", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    a.provider.awareness.setLocalStateField("user", { id: "user_a", name: "Ada" });
    await waitFor(
      () => (running.collab.rooms.get(room)?.awareness.getStates().size ?? 0) > 0,
      "server",
    );

    const late = await client(room, "user_c", "Cy");
    await waitFor(
      () => late.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === "Ada",
      "late joiner to see A",
    );
  });
});

describe("connection auth", () => {
  test("a valid token is accepted", async () => {
    const room = nextRoom();
    expect(await upgradeStatus(`${running.wsUrl}/${room}?token=${await tokenFor(room)}`)).toBe(101);
  });

  test("missing, garbage, expired and foreign-secret tokens are rejected with 401", async () => {
    const room = nextRoom();
    const expired = await tokenFor(room, "user_a", "Ada", -10);
    const { signRoomToken } = await import("@codesync/shared/token");
    const foreign = await signRoomToken(
      { sub: "user_a", roomId: room, name: "Ada", avatar: null },
      "some-other-secret-that-is-also-long-enough",
    );

    for (const query of [
      "",
      "?token=",
      "?token=garbage",
      `?token=${expired}`,
      `?token=${foreign}`,
    ]) {
      expect(await upgradeStatus(`${running.wsUrl}/${room}${query}`), query).toBe(401);
    }
  });

  test("a token for a different room is rejected with 403", async () => {
    const token = await tokenFor(nextRoom());
    expect(await upgradeStatus(`${running.wsUrl}/${nextRoom()}?token=${token}`)).toBe(403);
  });

  test("malformed room ids are rejected with 404", async () => {
    const token = await tokenFor("room000000");
    expect(await upgradeStatus(`${running.wsUrl}/..%2F..%2Fetc?token=${token}`)).toBe(404);
  });

  test("with an origin allowlist, other sites are refused even with a valid token", async () => {
    const guarded = await startServer({ allowedOrigins: ["https://codesync.example"] });
    try {
      const room = nextRoom();
      const url = `${guarded.wsUrl}/${room}?token=${await tokenFor(room)}`;
      expect(await upgradeStatus(url, "https://codesync.example")).toBe(101);
      expect(await upgradeStatus(url, "https://evil.example")).toBe(403);
      // Non-browser clients send no Origin; the token is still required.
      expect(await upgradeStatus(url)).toBe(101);
    } finally {
      await guarded.collab.close();
    }
  });
});

describe("robustness and metrics", () => {
  test("a malformed message drops only that socket", async () => {
    const room = nextRoom();
    const good = await client(room, "user_a", "Ada");
    const raw = new WebSocket(
      `${running.wsUrl}/${room}?token=${await tokenFor(room, "user_x", "X")}`,
    );
    await new Promise((resolve) => raw.once("open", resolve));

    const closed = new Promise<number>((resolve) => raw.once("close", (code) => resolve(code)));
    raw.send(Buffer.from([0x63, 0xff, 0xff]));
    expect(await closed).toBe(1007);

    good.text.insert(0, "still works");
    await waitFor(
      () => running.collab.rooms.get(room)?.doc.getText("monaco").toString() === "still works",
      "server to keep serving the good client",
    );
  });

  test("metrics report clients and rooms, and empty rooms are evicted", async () => {
    const room = nextRoom();
    const a = await client(room, "user_a", "Ada");
    await client(room, "user_b", "Bob");
    a.text.insert(0, "x");

    const res = await fetch(`${running.httpUrl}/metrics`);
    const metrics = (await res.json()) as Record<string, number>;
    expect(metrics.connectedClients).toBeGreaterThanOrEqual(2);
    expect(metrics.activeRooms).toBeGreaterThanOrEqual(1);
    expect(metrics.updatesPerSecond).toBeGreaterThan(0);

    for (const c of clients.splice(0)) c.provider.destroy();
    await waitFor(() => running.collab.rooms.get(room) === undefined, "room eviction");
  });
});
