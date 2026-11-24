import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { RoomPersistence } from "../src/persistence";
import { MemoryStore, versionsToDrop } from "../src/store";

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

describe("history limits", () => {
  const at = (version: number, minutes: number, bytes = 10) => ({
    version,
    createdAt: new Date(minutes * 60_000),
    bytes,
  });

  test("nothing is dropped within the limits", () => {
    expect(versionsToDrop([at(1, 0), at(2, 1), at(3, 2)], 3, 30)).toEqual([]);
  });

  test("a burst of versions does not push out older history", () => {
    const older = [at(1, 0), at(2, 600), at(3, 1200)];
    const burst = Array.from({ length: 20 }, (_, i) => at(4 + i, 5000 + i));
    const dropped = versionsToDrop([...older, ...burst], 10, 1_000_000);
    expect(dropped).toHaveLength(13);
    for (const kept of [1, 2, 3, 23]) expect(dropped).not.toContain(kept);
  });

  test("large versions are limited by total size, and the newest always stays", () => {
    const versions = [at(1, 0, 60), at(2, 10, 60), at(3, 20, 60)];
    expect(versionsToDrop(versions, 50, 130)).toEqual([2]);
    expect(versionsToDrop(versions, 50, 1)).toEqual([2, 1]);
  });

  test("a lot of written bytes are folded into a snapshot early", async () => {
    const { store, text, persistence } = await setup(undefined, { compactBytes: 5_000 });
    text.insert(0, "x".repeat(6_000));
    await persistence.flush();
    expect(store.snapshots.get(ROOM)).toHaveLength(1);
    expect(store.updates.get(ROOM)).toEqual([]);
  });
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
  test("a write that landed but reported failure doesn't lose what is typed next", async () => {
    const store = new MemoryStore();
    const original = store.appendUpdate.bind(store);
    let lostConfirmations = 1;
    vi.spyOn(store, "appendUpdate").mockImplementation(async (...args) => {
      await original(...args);
      if (lostConfirmations-- > 0) throw new Error("connection dropped after commit");
    });

    const { text, persistence } = await setup(store);
    text.insert(0, "first ");
    await persistence.flush(); // stored, but reported as failed and queued again
    text.insert(6, "second");
    await persistence.flush();
    expect(await reload(store)).toBe("first second");
  });

  test("shutdown saves edits whose last write failed", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "appendUpdate").mockRejectedValue(new Error("db down"));
    const { text, persistence } = await setup(store);
    text.insert(0, "not written yet");
    await persistence.close();
    expect(await reload(store)).toBe("not written yet");
  });

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
