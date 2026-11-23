// During a zero-downtime deploy the old and new collab servers briefly run side by side with
// clients on both. Neither may lose the other's edits.
import { getPrisma } from "@codesync/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaStore } from "../src/prisma-store";
import { createRoomFixture, hasDatabase } from "./db-fixtures";
import { connectClient, startServer } from "./helpers";

describe.skipIf(!hasDatabase)("two servers on the same room (Postgres)", () => {
  let fixture: Awaited<ReturnType<typeof createRoomFixture>>;

  beforeAll(async () => {
    fixture = await createRoomFixture();
  });

  afterAll(() => fixture.cleanup());

  const start = () =>
    startServer({ store: new PrismaStore(getPrisma()), persistence: { batchMs: 20 } });

  test("edits made through either server survive both shutting down", async () => {
    const { roomId, userId } = fixture;
    const oldServer = await start();
    const newServer = await start();
    const a = await connectClient(oldServer.wsUrl, roomId, userId, "A");
    const b = await connectClient(newServer.wsUrl, roomId, userId, "B");

    for (let i = 0; i < 5; i++) {
      a.text.insert(0, `old${i};`);
      b.text.insert(0, `new${i};`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    a.provider.destroy();
    b.provider.destroy();
    await oldServer.collab.close();
    await newServer.collab.close();

    const third = await start();
    const reader = await connectClient(third.wsUrl, roomId, userId, "Reader");
    const text = reader.text.toString();
    reader.provider.destroy();
    await third.collab.close();
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`old${i};`);
      expect(text).toContain(`new${i};`);
    }
  }, 30_000);
});
