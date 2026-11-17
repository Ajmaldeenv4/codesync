import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { RoomPersistence } from "../src/persistence";
import { MemoryStore } from "../src/store";

const ROOM = "room000001";

async function setup(store = new MemoryStore(), options = {}) {
  const doc = new Y.Doc();
  const persistence = await RoomPersistence.load(ROOM, store, doc, {
    batchMs: 500,
    onError: () => undefined,
    ...options,
  });
  doc.on("update", (update: Uint8Array) => persistence.record(update));
  return { store, doc, persistence, text: doc.getText("monaco") };
}

async function reload(store: MemoryStore) {
  const doc = new Y.Doc();
  await RoomPersistence.load(ROOM, store, doc);
  return doc.getText("monaco").toString();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("batching", () => {
  test("keystrokes inside one window become a single row", async () => {
    vi.useFakeTimers();
    const { store, text } = await setup();
    for (const ch of "hello") text.insert(text.length, ch);

    expect(store.updates.get(ROOM) ?? []).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.updates.get(ROOM)).toHaveLength(1);
    expect(await reload(store)).toBe("hello");
  });

  test("continuous typing is still written every window (fixed window, not a resetting debounce)", async () => {
    vi.useFakeTimers();
    const { store, text } = await setup();
    for (let i = 0; i < 12; i++) {
      text.insert(text.length, "x");
      await vi.advanceTimersByTimeAsync(100);
    }
    // 1.2 s of typing with a 500 ms window: at least two rows already on disk.
    expect((store.updates.get(ROOM) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("flush() writes immediately", async () => {
    const { store, text, persistence } = await setup();
    text.insert(0, "now");
    await persistence.flush();
    expect(store.updates.get(ROOM)).toHaveLength(1);
  });
});

describe("compaction", () => {
  test("after `compactEvery` rows, rows fold into a snapshot", async () => {
    const { store, text, persistence } = await setup(undefined, { compactEvery: 3 });
    for (const part of ["a", "b", "c"]) {
      text.insert(text.length, part);
      await persistence.flush();
    }
    expect(store.snapshots.get(ROOM)).toHaveLength(1);
    expect(store.updates.get(ROOM)).toHaveLength(0);
    expect(await reload(store)).toBe("abc");
  });

  test("close() snapshots pending changes, and does nothing when there are none", async () => {
    const { store, text, persistence } = await setup();
    text.insert(0, "final");
    await persistence.close();
    expect(store.snapshots.get(ROOM)?.map((s) => s.version)).toEqual([1]);
    expect(await reload(store)).toBe("final");

    const again = await setup(store);
    await again.persistence.close();
    expect(store.snapshots.get(ROOM)?.map((s) => s.version)).toEqual([1]);
  });

  test("a reload combines the latest snapshot with later rows", async () => {
    const store = new MemoryStore();
    const first = await setup(store);
    first.text.insert(0, "snap");
    await first.persistence.close();

    const second = await setup(store);
    expect(second.text.toString()).toBe("snap");
    second.text.insert(4, "+row");
    await second.persistence.flush();

    expect(store.snapshots.get(ROOM)).toHaveLength(1);
    expect(store.updates.get(ROOM)).toHaveLength(1);
    expect(await reload(store)).toBe("snap+row");
  });
});

describe("failures", () => {
  test("a failed write is retried and nothing is lost", async () => {
    const store = new MemoryStore();
    const original = store.appendUpdate.bind(store);
    let failures = 1;
    vi.spyOn(store, "appendUpdate").mockImplementation((...args) => {
      if (failures-- > 0) return Promise.reject(new Error("db down"));
      return original(...args);
    });

    const { text, persistence } = await setup(store, { retryMs: 10 });
    text.insert(0, "survives");
    await persistence.flush(); // fails, re-queued
    await new Promise((resolve) => setTimeout(resolve, 50)); // retry fires
    await persistence.flush();

    expect(await reload(store)).toBe("survives");
  });
});
