import { connect, createRoom, disconnect, sleep, startCollab, waitFor, freePort } from "./harness";
import type { Client } from "./harness";
import { round, summarize, type Summary } from "./stats";

/** Records, for every edit, how long each observing client takes to see it. */
function trackEdits(observers: Client[], onSeen: (editId: number) => void) {
  for (const observer of observers) {
    observer.text.observe((event, transaction) => {
      if (transaction.local) return;
      for (const part of event.delta) {
        if (typeof part.insert !== "string") continue;
        for (const match of part.insert.matchAll(/(\d+);/g)) onSeen(Number(match[1]));
      }
    });
  }
}

/** One person types, another watches: time from local edit to the edit appearing remotely. */
export async function syncLatency(edits = 500): Promise<Summary> {
  const port = await freePort();
  const server = await startCollab(port);
  const room = await createRoom();
  try {
    const writer = await connect(port, room.roomId);
    const reader = await connect(port, room.roomId);
    const sentAt: number[] = [];
    const samples: number[] = [];
    trackEdits([reader], (id) => samples.push(performance.now() - (sentAt[id] ?? NaN)));

    for (let id = 0; id < edits; id++) {
      sentAt[id] = performance.now();
      writer.text.insert(writer.text.length, `${id};`);
      await sleep(20);
    }
    await waitFor(() => samples.length === edits, "every edit to arrive");
    disconnect(writer);
    disconnect(reader);
    return summarize(samples);
  } finally {
    await server.kill();
    await room.cleanup();
  }
}

export interface RoomLoad {
  clients: number;
  connected: number;
  edits: number;
  deliveries: number;
  lost: number;
  disconnects: number;
  converged: boolean;
  latency: Summary;
}

/** N clients in one room; 10 of them type 2 edits/s each while everyone observes every edit. */
export async function roomLoad(clientCount: number, seconds = 10): Promise<RoomLoad> {
  const port = await freePort();
  const server = await startCollab(port);
  const room = await createRoom();
  const clients: Client[] = [];
  try {
    for (let i = 0; i < clientCount; i += 10) {
      const batch = Array.from({ length: Math.min(10, clientCount - i) }, () =>
        connect(port, room.roomId),
      );
      clients.push(...(await Promise.all(batch)));
    }
    await sleep(1000);

    const sentAt: number[] = [];
    const samples: number[] = [];
    trackEdits(clients, (id) => samples.push(performance.now() - (sentAt[id] ?? NaN)));

    const writers = clients.slice(0, 10);
    const rounds = seconds * 2;
    let nextId = 0;
    for (let r = 0; r < rounds; r++) {
      for (const writer of writers) {
        const id = nextId++;
        sentAt[id] = performance.now();
        writer.text.insert(writer.text.length, `${id};`);
        await sleep(500 / writers.length);
      }
    }
    const expected = nextId * (clientCount - 1);
    const deadline = performance.now() + 20_000;
    while (samples.length < expected && performance.now() < deadline) await sleep(20);

    const reference = clients[0]?.text.toString();
    return {
      clients: clientCount,
      connected: clients.filter((c) => c.provider.wsconnected).length,
      edits: nextId,
      deliveries: samples.length,
      lost: expected - samples.length,
      disconnects: clients.reduce((sum, c) => sum + c.disconnects, 0),
      converged: clients.every((c) => c.text.toString() === reference),
      latency: summarize(samples),
    };
  } finally {
    for (const c of clients) disconnect(c);
    await server.kill();
    await room.cleanup();
  }
}

export interface Recovery {
  intact: number;
  runs: number;
  milliseconds: Summary;
}

/** Kill -9 the server, restart it, and time until a client has the full document again. */
export async function recovery(runs = 10): Promise<Recovery> {
  const port = await freePort();
  const room = await createRoom();
  let server = await startCollab(port);
  try {
    const writer = await connect(port, room.roomId);
    const code = "print('a line of code that must survive a crash')\n".repeat(400);
    writer.text.insert(0, code);
    await sleep(1500);
    disconnect(writer);

    const samples: number[] = [];
    let intact = 0;
    for (let i = 0; i < runs; i++) {
      await server.kill();
      const startedAt = performance.now();
      server = await startCollab(port);
      const reader = await connect(port, room.roomId);
      samples.push(performance.now() - startedAt);
      if (reader.text.toString() === code) intact += 1;
      disconnect(reader);
    }
    return {
      intact,
      runs,
      milliseconds: { ...summarize(samples), max: round(Math.max(...samples)) },
    };
  } finally {
    await server.kill();
    await room.cleanup();
  }
}
