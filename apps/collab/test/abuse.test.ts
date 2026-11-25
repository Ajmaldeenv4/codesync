// A signed-in user attacking the server: none of this may crash it, exhaust it, or let the user
// pass for someone else.
import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { CLOSE_ROOM_FULL, MESSAGE_NOTICE } from "@codesync/shared/doc";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import type { CollabServerOptions } from "../src/server";
import { MemoryStore } from "../src/store";
import {
  connectClient,
  startServer,
  tokenFor,
  upgradeStatus,
  waitFor,
  type RunningServer,
} from "./helpers";

let running: RunningServer | undefined;
const sockets: WebSocket[] = [];
const cleanups: (() => void)[] = [];

async function start(options: Partial<CollabServerOptions> = {}) {
  running = await startServer({ persistence: { batchMs: 20 }, ...options });
  return running;
}

async function rawSocket(server: RunningServer, room: string, sub = "mallory") {
  const ws = new WebSocket(`${server.wsUrl}/${room}?token=${await tokenFor(room, sub, "Mallory")}`);
  sockets.push(ws);
  let closeCode: number | undefined;
  ws.on("close", (code) => (closeCode = code));
  ws.on("error", () => undefined);
  await new Promise((resolve) => ws.once("open", resolve));
  return { ws, closeCode: () => closeCode };
}

async function client(server: RunningServer, room: string, sub: string, name: string) {
  const c = await connectClient(server.wsUrl, room, sub, name);
  cleanups.push(() => c.provider.destroy());
  return c;
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessUpdate(entries: { id: number; clock: number; state: unknown }[]): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const { id, clock, state } of entries) {
    encoding.writeVarUint(inner, id);
    encoding.writeVarUint(inner, clock);
    encoding.writeVarString(inner, JSON.stringify(state));
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
  return encoding.toUint8Array(encoder);
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const ws of sockets.splice(0)) ws.terminate();
  await running?.collab.close();
  running = undefined;
});

describe("dropped connections", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill();
  });

  test("a connection reset while its room is loading does not crash the process", async () => {
    // A separate process: the failure being tested is an uncaught exception.
    child = fork(fileURLToPath(new URL("./slow-server.ts", import.meta.url)), {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let exited = false;
    child.once("exit", () => (exited = true));
    const port = await new Promise<number>((resolve) => child?.once("message", resolve));

    const token = await tokenFor("abcdefghij", "mallory");
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /abcdefghij?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
            "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
        setTimeout(() => {
          socket.resetAndDestroy();
          resolve();
        }, 150);
      });
      socket.on("error", () => undefined);
    });
    await settle(1000);

    expect(exited).toBe(false);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 20_000);

  test("an invalid handshake does not keep its room open", async () => {
    const server = await start();
    const { port } = new URL(server.httpUrl);
    const token = await tokenFor("handshake1");
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        // No Sec-WebSocket-Key, so the WebSocket library refuses it after the token is accepted.
        socket.write(
          `GET /handshake1?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
            "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      socket.on("data", () => undefined);
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    await waitFor(() => server.collab.rooms.size === 0, "the room to be released");
  });
});

describe("limits", () => {
  test("one user can only hold so many connections", async () => {
    const server = await start({ limits: { connectionsPerUser: 2 } });
    await rawSocket(server, "connlimit1");
    const second = await rawSocket(server, "connlimit2");
    const url = async (sub: string) =>
      `${server.wsUrl}/connlimit3?token=${await tokenFor("connlimit3", sub)}`;
    expect(await upgradeStatus(await url("mallory"))).toBe(429);
    // Other people are unaffected, and closing one frees its place.
    expect(await upgradeStatus(await url("ada"))).toBe(101);
    second.ws.terminate();
    await settle();
    expect(await upgradeStatus(await url("mallory"))).toBe(101);
  });

  test("a room only accepts so many connections", async () => {
    const server = await start({ limits: { connectionsPerRoom: 1 } });
    await rawSocket(server, "roomlimit1", "user_1");
    const token = await tokenFor("roomlimit1", "user_2");
    expect(await upgradeStatus(`${server.wsUrl}/roomlimit1?token=${token}`)).toBe(429);
  });

  test("a user cannot reconnect in a tight loop", async () => {
    const server = await start({ limits: { userConnects: { capacity: 3, perSecond: 0 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const token = await tokenFor("looping001", "mallory");
      statuses.push(await upgradeStatus(`${server.wsUrl}/looping001?token=${token}`));
    }
    expect(statuses).toEqual([101, 101, 101, 429, 429]);
  });

  test("a document cannot grow past its limit, and small edits still work near it", async () => {
    const server = await start({ limits: { docBytes: 50_000, docBytesHard: 60_000 } });
    const { ws, closeCode } = await rawSocket(server, "biglimit01");
    const doc = new Y.Doc();
    doc.on("update", (u: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(syncUpdate(u)));
    doc.getText("monaco").insert(0, "x".repeat(49_900));
    await waitFor(
      () => server.collab.rooms.get("biglimit01")?.text.length === 49_900,
      "the first edit",
    );
    doc.getText("monaco").insert(0, "small ");
    doc.getText("monaco").delete(0, 6);
    await settle();
    expect(closeCode()).toBeUndefined();

    doc.getText("monaco").insert(0, "y".repeat(5_000));
    await waitFor(() => closeCode() !== undefined, "the connection to be closed");
    expect(closeCode()).toBe(4413);
  });

  test("the reason is sent as a message, since some proxies swallow close codes", async () => {
    const server = await start({ limits: { docBytes: 1_000, docBytesHard: 2_000 } });
    const { ws, closeCode } = await rawSocket(server, "notice0001");
    const notices: number[] = [];
    ws.on("message", (data: Buffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(decoder) === MESSAGE_NOTICE) {
        notices.push(decoding.readVarUint(decoder));
      }
    });
    const doc = new Y.Doc();
    doc.getText("monaco").insert(0, "x".repeat(5_000));
    ws.send(syncUpdate(Y.encodeStateAsUpdate(doc)));
    await waitFor(() => closeCode() !== undefined, "the connection to be closed");
    expect(notices).toEqual([CLOSE_ROOM_FULL]);
  });

  test("a flood of edits is cut off even when the document stays small", async () => {
    const server = await start({ limits: { userBytes: { capacity: 200_000, perSecond: 0 } } });
    const { ws, closeCode } = await rawSocket(server, "floodroom1");
    const doc = new Y.Doc();
    doc.on("update", (u: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(syncUpdate(u)));
    for (let i = 0; i < 5; i++) {
      doc.getText("monaco").insert(0, "y".repeat(50_000));
      doc.getText("monaco").delete(0, 50_000);
    }
    await waitFor(() => closeCode() !== undefined, "the connection to be closed");
    expect(closeCode()).toBe(1008);
  });

  test("asking for the whole document over and over is cut off", async () => {
    const server = await start({ limits: { userReplyBytes: { capacity: 100_000, perSecond: 0 } } });
    const ada = await client(server, "replyroom1", "ada", "Ada");
    ada.text.insert(0, "z".repeat(40_000));
    await waitFor(() => server.collab.rooms.get("replyroom1")?.text.length === 40_000, "the text");
    const { ws, closeCode } = await rawSocket(server, "replyroom1");
    for (let i = 0; i < 5; i++) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, new Y.Doc());
      ws.send(encoding.toUint8Array(encoder));
    }
    await waitFor(() => closeCode() !== undefined, "the connection to be closed");
    expect(closeCode()).toBe(1008);
    expect(ada.provider.wsconnected).toBe(true);
  });

  test("a client that stops reading is disconnected", async () => {
    // Only the slow reader may hit a limit here.
    const plenty = { capacity: Infinity, perSecond: 0 };
    const server = await start({
      limits: { bufferedBytes: 200_000, userBytes: plenty, docBytes: 1e9, docBytesHard: 1e9 },
    });
    const { ws } = await rawSocket(server, "slowreader", "slow");
    (ws as unknown as { _socket: net.Socket })._socket.pause();
    const ada = await client(server, "slowreader", "ada", "Ada");
    const connections = () => server.collab.rooms.get("slowreader")?.connectionCount;
    expect(connections()).toBe(2);
    // Enough to fill the operating system's own socket buffers first.
    for (let i = 0; i < 400 && connections() === 2; i++) {
      ada.text.insert(0, "y".repeat(100_000));
      ada.text.delete(0, 100_000);
      await settle(5);
    }
    await waitFor(() => connections() === 1, "the slow reader to be dropped");
    expect(ada.provider.wsconnected).toBe(true);
  }, 20_000);

  test("updates that depend on missing ones are not kept for long", async () => {
    const server = await start();
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => updates.push(u));
    source.getText("monaco").insert(0, "first");
    source.getText("monaco").insert(5, " second");
    const { ws } = await rawSocket(server, "pendingrm1");
    ws.send(syncUpdate(updates[1] as Uint8Array));
    const doc = () => server.collab.rooms.get("pendingrm1")?.doc;
    await waitFor(() => Boolean(doc()?.store.pendingStructs), "the update to be held back");

    const ada = await client(server, "pendingrm1", "ada", "Ada");
    ada.text.insert(0, "hi");
    await waitFor(() => server.collab.rooms.get("pendingrm1")?.text.toString() === "hi", "edit");
    expect(doc()?.store.pendingStructs).toBeNull();
  });
});

describe("presence", () => {
  test("a connection cannot invent a crowd of users", async () => {
    const server = await start();
    const { ws } = await rawSocket(server, "crowdroom1");
    const entries = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      clock: 1,
      state: { user: { id: `fake-${i}`, name: "Fake" } },
    }));
    ws.send(awarenessUpdate(entries));
    await settle();
    const states = server.collab.rooms.get("crowdroom1")?.awareness.getStates();
    expect(states?.size).toBe(4);
  });

  test("an oversized presence state is ignored", async () => {
    const server = await start();
    const { ws } = await rawSocket(server, "hugestate1");
    ws.send(awarenessUpdate([{ id: 7, clock: 1, state: { blob: "x".repeat(100_000) } }]));
    await settle();
    expect(server.collab.rooms.get("hugestate1")?.awareness.getStates().size).toBe(0);
  });

  test("a connection cannot change or remove someone else's presence", async () => {
    const server = await start();
    const ada = await client(server, "presence01", "ada", "Ada");
    ada.provider.awareness.setLocalStateField("user", { id: "ada", name: "Ada" });
    const states = () => server.collab.rooms.get("presence01")?.awareness.getStates();
    await waitFor(() => states()?.has(ada.doc.clientID) ?? false, "Ada's presence");

    const { ws } = await rawSocket(server, "presence01");
    const id = ada.doc.clientID;
    ws.send(awarenessUpdate([{ id, clock: 1000, state: { user: { id: "ada", name: "Fake" } } }]));
    ws.send(awarenessUpdate([{ id, clock: 1001, state: null }]));
    await settle();
    expect(states()?.get(id)).toMatchObject({ user: { name: "Ada" } });
  });

  test("the same user reconnecting takes over their own presence", async () => {
    const server = await start();
    const first = await rawSocket(server, "takeover01", "ada");
    first.ws.send(awarenessUpdate([{ id: 42, clock: 1, state: { user: { id: "ada" } } }]));
    await settle();
    const second = await rawSocket(server, "takeover01", "ada");
    second.ws.send(awarenessUpdate([{ id: 42, clock: 2, state: { user: { id: "ada" } } }]));
    await settle();
    first.ws.terminate();
    await settle();
    expect(server.collab.rooms.get("takeover01")?.awareness.getStates().has(42)).toBe(true);
  });
});

describe("chat authors", () => {
  const chatOf = (c: { doc: Y.Doc }) => c.doc.getArray<Record<string, unknown>>("chat").toArray();

  test("a message posted under another name is shown under the real sender's", async () => {
    const store = new MemoryStore();
    const server = await start({ store });
    const ada = await client(server, "spoofroom1", "ada", "Ada");
    const mallory = await client(server, "spoofroom1", "mallory", "Mallory");
    const message = { id: "spoofed-1", userId: "ada", name: "Ada", text: "I quit", ts: 1 };
    mallory.doc.getArray("chat").push([message]);

    await waitFor(() => chatOf(ada)[0]?.userId === "mallory", "the author to be corrected");
    expect(chatOf(ada)).toEqual([{ ...message, userId: "mallory", name: "Mallory" }]);
    await waitFor(() => store.chat.has("spoofed-1"), "the message to be saved");
    expect(store.chat.get("spoofed-1")?.userId).toBe("mallory");
  });

  test("using your own id with someone else's name is corrected too", async () => {
    const server = await start();
    const ada = await client(server, "spoofroom2", "ada", "Ada");
    const mallory = await client(server, "spoofroom2", "mallory", "Mallory");
    mallory.doc
      .getArray("chat")
      .push([{ id: "spoofed-2", userId: "mallory", name: "Ada", text: "hi", ts: 1 }]);
    await waitFor(() => chatOf(ada)[0]?.name === "Mallory", "the name to be corrected");
  });

  test("a message held back until a victim types is not credited to the victim", async () => {
    const store = new MemoryStore();
    const server = await start({ store });
    const ada = await client(server, "spoofroom3", "ada", "Ada");
    ada.text.insert(0, "a");
    await waitFor(() => server.collab.rooms.get("spoofroom3")?.text.length === 1, "Ada's edit");

    // Mallory predicts Ada's next edit and sends a message that depends on it.
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(ada.doc));
    forged.clientID = ada.doc.clientID;
    forged.getText("monaco").insert(1, "b");
    const before = Y.encodeStateVector(forged);
    forged.clientID = ada.doc.clientID + 1;
    forged.getText("monaco").insert(2, "c");
    forged
      .getArray("chat")
      .push([{ id: "held-back-1", userId: "ada", name: "Ada", text: "I quit", ts: 1 }]);
    const { ws } = await rawSocket(server, "spoofroom3");
    ws.send(syncUpdate(Y.encodeStateAsUpdate(forged, before)));
    await settle();
    ada.text.insert(1, "b");
    await settle(300);

    expect(store.chat.get("held-back-1")?.userId).not.toBe("ada");
    expect(chatOf(ada).filter((m) => m.userId === "ada")).toEqual([]);
  });

  test("a saved message resent by someone else keeps its author", async () => {
    const store = new MemoryStore();
    store.userNames.set("ada", "Ada");
    const saved = { id: "original-1", roomId: "resendrm01", userId: "ada", text: "hello" };
    await store.saveChat([{ ...saved, createdAt: new Date() }]);
    const server = await start({ store });
    const bob = await client(server, "resendrm01", "bob", "Bob");
    // As after a crash: Bob still holds Ada's message and the server has lost it.
    const message = { id: "original-1", userId: "ada", name: "Ada", text: "hello", ts: 1 };
    bob.doc.getArray("chat").push([message]);
    await settle(300);
    expect(chatOf(bob)).toEqual([message]);
  });

  test("messages that cannot be displayed are not saved", async () => {
    const store = new MemoryStore();
    const server = await start({ store });
    const mallory = await client(server, "badchat001", "mallory", "Mallory");
    const base = { userId: "mallory", name: "Mallory", text: "x" };
    mallory.doc.getArray("chat").push([
      { ...base, id: "bad-date-1", ts: Number.MAX_SAFE_INTEGER },
      { ...base, id: "nul-byte-1", ts: 1, text: "a\u0000b" },
      { ...base, id: "fine-msg-1", ts: 1 },
    ]);
    await waitFor(() => store.chat.has("fine-msg-1"), "the valid message");
    expect([...store.chat.keys()]).toEqual(["fine-msg-1"]);
  });

  test("a flood of messages is not all saved", async () => {
    const store = new MemoryStore();
    const server = await start({ store, limits: { userChat: { capacity: 5, perSecond: 0 } } });
    const mallory = await client(server, "chatflood1", "mallory", "Mallory");
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `flood-msg-${i}`,
      userId: "mallory",
      name: "Mallory",
      text: "spam",
      ts: 1,
    }));
    mallory.doc.getArray("chat").push(messages);
    await waitFor(() => store.chat.size > 0, "some messages");
    await settle();
    expect(store.chat.size).toBe(5);
  });
});
