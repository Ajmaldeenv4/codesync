// Real-database fixtures for the Postgres-backed tests (skipped when DATABASE_URL is unset).
import { getPrisma } from "@codesync/db";
import { loadEnvFileIfExists } from "@codesync/shared/node";
import { randomUUID } from "node:crypto";

loadEnvFileIfExists(new URL("../../../.env", import.meta.url));

export const hasDatabase = Boolean(process.env.DATABASE_URL);

/** A user who owns a fresh room. Room ids follow the nanoid(10) shape the server accepts. */
export async function createRoomFixture() {
  const db = getPrisma();
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const user = await db.user.create({
    data: { name: "Fixture", email: `fixture-${tag}@vitest.codesync.invalid` },
  });
  const room = await db.room.create({
    data: {
      id: `fx${tag}`,
      name: "fixture",
      language: "python",
      ownerId: user.id,
      members: { create: { userId: user.id } },
    },
  });
  return {
    userId: user.id,
    roomId: room.id,
    /** Deletes the user; rooms, updates, snapshots and chat cascade. */
    cleanup: () => db.user.delete({ where: { id: user.id } }).then(() => undefined),
  };
}
